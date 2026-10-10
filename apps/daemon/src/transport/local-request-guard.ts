import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export class LocalRequestRejectedError extends Error {
  constructor() {
    super("Request is not allowed by the local service boundary.");
    this.name = "LocalRequestRejectedError";
  }
}

export interface DesktopHostRequestBinding {
  readonly hostToken: string;
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  return (
    /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(value) || /^\[::1\](?::\d{1,5})?$/.test(value)
  );
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      ["127.0.0.1", "localhost", "::1"].includes(hostname)
    );
  } catch {
    return false;
  }
}

export function assertLoopbackRequest(
  request: FastifyRequest,
  desktopHost?: DesktopHostRequestBinding,
): void {
  const host = request.headers.host;
  const hostValue = Array.isArray(host) ? host[0] : host;
  if (!isLoopbackHost(hostValue)) throw new LocalRequestRejectedError();

  const origin = request.headers.origin;
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  if (originValue !== undefined && !isLoopbackOrigin(originValue)) {
    throw new LocalRequestRejectedError();
  }

  if (desktopHost !== undefined && isDaemonApiPath(request.url)) {
    const received = request.headers["x-caelush-host-token"];
    if (typeof received !== "string" || !matchesHostToken(received, desktopHost.hostToken)) {
      throw new LocalRequestRejectedError();
    }
  }
}

function isDaemonApiPath(requestUrl: string): boolean {
  let requestPath = requestUrl.split("?", 1)[0] ?? "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let normalized: string;
    try {
      normalized = new URL(requestPath, "http://127.0.0.1").pathname;
    } catch {
      return false;
    }
    if (normalized === "/api/v1" || normalized.startsWith("/api/v1/")) return true;
    try {
      const decoded = decodeURIComponent(requestPath);
      if (decoded === requestPath) return false;
      requestPath = decoded;
    } catch {
      return false;
    }
  }
  // Treat paths that remain ambiguous after bounded decoding as protected in Desktop mode.
  return true;
}

function matchesHostToken(received: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(received) || !/^[A-Za-z0-9_-]{43}$/u.test(expected)) {
    return false;
  }
  const receivedBytes = Buffer.from(received, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    receivedBytes.byteLength === 32 &&
    expectedBytes.byteLength === 32 &&
    receivedBytes.toString("base64url") === received &&
    expectedBytes.toString("base64url") === expected &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}
