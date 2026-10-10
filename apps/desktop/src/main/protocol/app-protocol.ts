import { protocol } from "electron";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolveStaticFile } from "./static-resources.js";

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

const UNAVAILABLE_DAEMON_BODY = JSON.stringify({
  error: {
    code: "LOCAL_AGENT_INTEGRATION_PENDING",
    message: "The protected local Agent service is not connected in this version.",
  },
});

export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle("caelush-app", async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response("Not found", 404);
    }
    if (url.hostname !== "app" || url.username !== "" || url.password !== "")
      return response("Not found", 404);
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      return new Response(UNAVAILABLE_DAEMON_BODY, {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": CSP,
        },
      });
    }
    const filePath = await resolveStaticFile(rendererRoot, url.pathname);
    if (filePath === null) return response("Not found", 404);
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
          "Cache-Control":
            extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
          "Content-Security-Policy": CSP,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    } catch {
      return response("Not found", 404);
    }
  });
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
