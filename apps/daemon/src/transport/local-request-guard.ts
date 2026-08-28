import type { FastifyRequest } from "fastify";

export class LocalRequestRejectedError extends Error {
  constructor() {
    super("Request is not allowed by the local service boundary.");
    this.name = "LocalRequestRejectedError";
  }
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

export function assertLoopbackRequest(request: FastifyRequest): void {
  const host = request.headers.host;
  const hostValue = Array.isArray(host) ? host[0] : host;
  if (!isLoopbackHost(hostValue)) throw new LocalRequestRejectedError();

  const origin = request.headers.origin;
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  if (originValue !== undefined && !isLoopbackOrigin(originValue)) {
    throw new LocalRequestRejectedError();
  }
}
