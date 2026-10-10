import { protocol } from "electron";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolveStaticFile } from "./static-resources.js";
import type { DesktopLocalProxy } from "./local-proxy.js";

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
});

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface RegisterAppProtocolOptions {
  readonly rendererRoot: string;
  readonly agentRoot: string;
  readonly localProxy: DesktopLocalProxy;
  readonly isAgentAvailable: () => boolean;
}

export function registerAppProtocol(options: RegisterAppProtocolOptions): void {
  protocol.handle("caelush-login", async (request) => {
    const url = parseAppUrl(request.url, "caelush-login");
    if (url === null) return response("Not found", 404);
    const filePath = await resolveStaticFile(options.rendererRoot, url.pathname);
    if (filePath === null) return response("Not found", 404);
    return serveStaticFile(filePath, false);
  });

  protocol.handle("caelush-app", async (request) => {
    const url = parseAppUrl(request.url, "caelush-app");
    if (url === null) return response("Not found", 404);
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      return options.localProxy.handle(request);
    }
    if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
      if (!options.isAgentAvailable()) return response("The local Agent is not ready.", 503);
      const agentPath = url.pathname.slice("/agent".length);
      const filePath =
        agentPath === "" || agentPath === "/"
          ? await resolveStaticFile(options.agentRoot, "/")
          : await resolveStaticFile(options.agentRoot, agentPath);
      const resolvedFile =
        filePath ??
        (hasFileExtension(agentPath) ? null : await resolveStaticFile(options.agentRoot, "/"));
      if (resolvedFile === null) return response("Not found", 404);
      return serveStaticFile(resolvedFile, true);
    }
    return response("Not found", 404);
  });
}

function parseAppUrl(value: string, scheme: "caelush-app" | "caelush-login"): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== "app" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function serveStaticFile(filePath: string, agentDocument: boolean): Promise<Response> {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[extension];
  if (contentType === undefined) return response("Not found", 404);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > 8 * 1024 * 1024) return response("Not found", 404);
    const body = await readFile(filePath);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.byteLength),
        "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Security-Policy": CSP,
        "Referrer-Policy": agentDocument ? "same-origin" : "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch {
    return response("Not found", 404);
  }
}

function hasFileExtension(value: string): boolean {
  return path.posix.extname(value) !== "";
}

function response(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
    },
  });
}
