/** Only an owned loopback daemon generation can receive the host authorization token. */
export function isOwnedLoopbackTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
export function isValidHostToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}
export function ownedDaemonHeaders(lease: {
  readonly baseUrl: string;
  readonly hostToken: string;
}): Readonly<Record<string, string>> | null {
  return isOwnedLoopbackTarget(lease.baseUrl) && isValidHostToken(lease.hostToken)
    ? { origin: lease.baseUrl, "x-caelush-host-token": lease.hostToken }
    : null;
}
