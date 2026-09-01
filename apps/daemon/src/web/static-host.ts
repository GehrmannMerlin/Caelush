import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceRefSchema, type WorkspaceRef } from "@caelush/protocol";

const BOOTSTRAP_MARKER = "__CAELUSH_BOOTSTRAP__";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export interface WebStaticHostOptions {
  readonly buildRoot: string;
  readonly workspace: WorkspaceRef;
}

interface PreparedStaticHost {
  readonly root: string;
  readonly indexHtml: string;
  readonly workspace: WorkspaceRef;
}

export function registerWebStaticHost(app: FastifyInstance, options: WebStaticHostOptions): void {
  const host = prepareStaticHost(options);

  app.get("/", async (_request, reply) => sendIndex(reply, host));
  app.get("/assets/*", async (request, reply) => {
    const filePath = resolveAssetPath(host.root, requestPath(request));
    if (filePath === undefined) return reply.callNotFound();
    return sendAsset(reply, filePath);
  });
  app.get("/*", async (request, reply) => {
    const pathname = requestPath(request);
    if (pathname === "/" || pathname.startsWith("/assets/") || pathname.startsWith("/api/")) {
      return reply.callNotFound();
    }
    return sendIndex(reply, host);
  });
}

function prepareStaticHost(options: WebStaticHostOptions): PreparedStaticHost {
  const root = canonicalDirectory(options.buildRoot);
  const indexPath = resolve(root, "index.html");
  const canonicalIndexPath = canonicalFile(root, indexPath);
  if (canonicalIndexPath === undefined) throw new Error("The Web index asset is unavailable.");
  const indexHtml = readFileSync(canonicalIndexPath, "utf8");
  if (!indexHtml.includes(BOOTSTRAP_MARKER)) {
    throw new Error("The Web index asset is missing its launch context marker.");
  }
  return { root, indexHtml, workspace: WorkspaceRefSchema.parse(options.workspace) };
}

function sendIndex(reply: FastifyReply, host: PreparedStaticHost): FastifyReply {
  const launchContext = escapeJsonForHtml(JSON.stringify({ workspace: host.workspace }));
  const body = host.indexHtml.replace(BOOTSTRAP_MARKER, launchContext);
  return applySecurityHeaders(reply)
    .header("cache-control", "no-cache")
    .type("text/html; charset=utf-8")
    .send(body);
}

function sendAsset(reply: FastifyReply, filePath: string): FastifyReply {
  return applySecurityHeaders(reply)
    .header("cache-control", "public, max-age=31536000, immutable")
    .type(contentType(filePath))
    .send(readFileSync(filePath));
}

function resolveAssetPath(root: string, requestUrl: string): string | undefined {
  const pathname = requestUrl.split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/assets/") || decoded.includes("\0") || decoded.includes("\\")) {
    return undefined;
  }
  const relativeUrl = decoded.slice(1);
  const segments = relativeUrl.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    return undefined;
  }
  const candidate = resolve(root, relativeUrl);
  return canonicalFile(root, candidate);
}

function canonicalDirectory(path: string): string {
  if (!existsSync(path)) throw new Error("The Web build root is unavailable.");
  const canonicalPath = realpathSync(path);
  if (!statSync(canonicalPath).isDirectory()) throw new Error("The Web build root is unavailable.");
  return canonicalPath;
}

function canonicalFile(root: string, candidate: string): string | undefined {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate);
  } catch {
    return undefined;
  }
  if (!isContained(root, canonicalPath)) return undefined;
  try {
    return statSync(canonicalPath).isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathToCandidate = relative(root, candidate);
  return (
    pathToCandidate === "" || (!pathToCandidate.startsWith(`..${sep}`) && pathToCandidate !== "..")
  );
}

function applySecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("content-security-policy", CSP)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer");
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function escapeJsonForHtml(value: string): string {
  return value
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function requestPath(request: FastifyRequest): string {
  return (request.raw.url ?? request.url).split("?", 1)[0] ?? "/";
}
