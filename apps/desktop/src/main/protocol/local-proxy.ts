import { randomUUID } from "node:crypto";

const APP_ORIGIN = "caelush-app://app";
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "last-event-id",
  "prefer",
] as const;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "authorization",
  "cookie",
  "x-caelush-host-token",
]);

export interface DesktopDaemonProxyLease {
  readonly baseUrl: string;
  readonly hostToken: string;
  readonly signal: AbortSignal;
  release(): void;
}

export interface DesktopLocalProxyOptions {
  readonly acquireLease: (requestSignal: AbortSignal) => DesktopDaemonProxyLease | null;
  readonly fetcher?: typeof fetch;
  readonly maxRequestBodyBytes?: number;
}

export class DesktopLocalProxy {
  private readonly fetcher: typeof fetch;
  private readonly maxRequestBodyBytes: number;

  constructor(private readonly options: DesktopLocalProxyOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
  }

  async handle(request: Request): Promise<Response> {
    const parsedUrl = parseTrustedApiUrl(request.url);
    if (parsedUrl === null)
      return proxyError(400, "INVALID_LOCAL_API_ROUTE", "The local API route is invalid.");
    if (!isTrustedAgentRequest(request)) {
      return proxyError(403, "DESKTOP_SOURCE_UNTRUSTED", "This local API request is not allowed.");
    }
    if (!ALLOWED_METHODS.has(request.method.toUpperCase())) {
      return proxyError(405, "METHOD_NOT_ALLOWED", "This local API method is not supported.");
    }
    if (request.headers.has("x-caelush-host-token")) {
      return proxyError(400, "INVALID_LOCAL_API_REQUEST", "The local API request is invalid.");
    }

    const rawContentLength = request.headers.get("content-length");
    if (rawContentLength !== null) {
      if (!/^\d+$/u.test(rawContentLength)) {
        return proxyError(400, "INVALID_LOCAL_API_REQUEST", "The local API request is invalid.");
      }
      if (Number(rawContentLength) > this.maxRequestBodyBytes) {
        return proxyError(413, "REQUEST_TOO_LARGE", "The local API request is too large.");
      }
    }
    if ((request.method === "GET" || request.method === "HEAD") && request.body !== null) {
      return proxyError(400, "INVALID_LOCAL_API_REQUEST", "The local API request is invalid.");
    }

    const lease = this.options.acquireLease(request.signal);
    if (lease === null) {
      return proxyError(401, "DESKTOP_ACCOUNT_UNAUTHORIZED", "Sign in to use the local Agent.");
    }
    if (!isOwnedLoopbackTarget(lease.baseUrl) || !isValidHostToken(lease.hostToken)) {
      lease.release();
      return proxyError(503, "LOCAL_AGENT_UNAVAILABLE", "The local Agent is unavailable.");
    }

    const target = new URL(parsedUrl.pathname + parsedUrl.search, lease.baseUrl);
    const headers = createUpstreamHeaders(request.headers, lease);
    const body =
      request.body === null || request.method === "GET" || request.method === "HEAD"
        ? undefined
        : limitBody(request.body, this.maxRequestBodyBytes);
    const init = {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body, duplex: "half" as const }),
      redirect: "manual" as const,
      signal: lease.signal,
    } as RequestInit & { readonly duplex?: "half" };

    let upstream: Response;
    try {
      upstream = await this.fetcher(target, init);
    } catch (error) {
      lease.release();
      if (error instanceof RequestBodyTooLargeError) {
        return proxyError(413, "REQUEST_TOO_LARGE", "The local API request is too large.");
      }
      if (request.signal.aborted)
        return proxyError(499, "REQUEST_CANCELLED", "The request was cancelled.");
      return proxyError(503, "LOCAL_AGENT_UNAVAILABLE", "The local Agent is unavailable.");
    }

    const responseHeaders = createSafeResponseHeaders(upstream.headers, lease.baseUrl);
    if (upstream.body === null) {
      lease.release();
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    const responseBody = forwardResponseBody(upstream.body, lease);
    try {
      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      lease.release();
      return proxyError(
        502,
        "LOCAL_AGENT_RESPONSE_INVALID",
        "The local Agent returned an invalid response.",
      );
    }
  }
}

export function isTrustedAgentRequest(request: Request): boolean {
  const initiatorOrigin = (request as Request & { readonly initiatorOrigin?: string })
    .initiatorOrigin;
  if (initiatorOrigin !== APP_ORIGIN) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== APP_ORIGIN) return false;
  if (request.referrer === "" || request.referrer === "about:client") return true;
  try {
    const referrer = new URL(request.referrer);
    return (
      referrer.protocol === "caelush-app:" &&
      referrer.hostname === "app" &&
      referrer.port === "" &&
      referrer.username === "" &&
      referrer.password === "" &&
      (referrer.pathname === "/agent" || referrer.pathname.startsWith("/agent/"))
    );
  } catch {
    return false;
  }
}

function parseTrustedApiUrl(value: string): URL | null {
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "caelush-app:" ||
    url.hostname !== "app" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) ||
    /%(?:25)*(?:2f|5c|2e|00)/iu.test(url.pathname)
  ) {
    return null;
  }
  const segments = url.pathname.split("/");
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.includes(":") ||
      /%(?:25)*(?:2f|5c|2e|00)/iu.test(decoded)
    ) {
      return null;
    }
  }
  return url;
}

function isOwnedLoopbackTarget(value: string): boolean {
  try {
    const target = new URL(value);
    return (
      target.protocol === "http:" &&
      target.hostname === "127.0.0.1" &&
      target.port !== "" &&
      target.username === "" &&
      target.password === "" &&
      target.pathname === "/" &&
      target.search === "" &&
      target.hash === ""
    );
  } catch {
    return false;
  }
}

function isValidHostToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function createUpstreamHeaders(source: Headers, lease: DesktopDaemonProxyLease): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("origin", lease.baseUrl);
  headers.set("x-caelush-host-token", lease.hostToken);
  return headers;
}

function createSafeResponseHeaders(source: Headers, ownedBaseUrl: string): Headers {
  const headers = new Headers();
  const connectionNamedHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  source.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName) || connectionNamedHeaders.has(normalizedName))
      return;
    if (normalizedName === "location") {
      const safeLocation = projectSafeRedirect(value, ownedBaseUrl);
      if (safeLocation !== null) headers.set("location", safeLocation);
      return;
    }
    headers.set(name, value);
  });
  return headers;
}

function projectSafeRedirect(value: string, ownedBaseUrl: string): string | null {
  try {
    const target = new URL(value, ownedBaseUrl);
    const base = new URL(ownedBaseUrl);
    if (
      target.origin !== base.origin ||
      (target.pathname !== "/api/v1" && !target.pathname.startsWith("/api/v1/")) ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== ""
    ) {
      return null;
    }
    return `${APP_ORIGIN}${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}

function limitBody(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  let receivedBytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maximumBytes) throw new RequestBodyTooLargeError();
        controller.enqueue(chunk);
      },
    }),
  );
}

function forwardResponseBody(
  body: ReadableStream<Uint8Array>,
  lease: DesktopDaemonProxyLease,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.signal.removeEventListener("abort", onAbort);
    lease.release();
  };
  const onAbort = () => {
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(release);
  };
  lease.signal.addEventListener("abort", onAbort, { once: true });
  if (lease.signal.aborted) onAbort();

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            release();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 1 },
  );
}

class RequestBodyTooLargeError extends Error {}

function proxyError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId: randomUUID() } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
