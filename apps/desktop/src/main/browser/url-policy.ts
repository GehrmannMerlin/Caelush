import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface BrowserAddress {
  readonly address: string;
  readonly family: number;
}

export interface BrowserUrlPolicyOptions {
  readonly lookup?: (hostname: string) => Promise<readonly BrowserAddress[]>;
}

export type BrowserGuestErrorCode =
  | "BROWSER_URL_INVALID"
  | "BROWSER_PRIVATE_ADDRESS"
  | "BROWSER_HOST_UNRESOLVED"
  | "BROWSER_LEASE_INVALID"
  | "BROWSER_NAVIGATION_FAILED"
  | "BROWSER_GUEST_UNAVAILABLE"
  | "BROWSER_BOUNDS_INVALID";

export class BrowserGuestError extends Error {
  constructor(
    readonly code: BrowserGuestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserGuestError";
  }
}

export async function validateBrowserUrl(
  value: string,
  options: BrowserUrlPolicyOptions = {},
): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2048) {
    throw invalidUrl();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.hostname.length === 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid") ||
    isIP(hostname) !== 0
  ) {
    throw invalidUrl();
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: readonly BrowserAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new BrowserGuestError(
      "BROWSER_HOST_UNRESOLVED",
      "The website host could not be verified.",
    );
  }
  if (addresses.length === 0) {
    throw new BrowserGuestError(
      "BROWSER_HOST_UNRESOLVED",
      "The website host could not be verified.",
    );
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new BrowserGuestError(
      "BROWSER_PRIVATE_ADDRESS",
      "Local and private network addresses are blocked in Browser Guest.",
    );
  }
  return url.toString();
}

export function validateBrowserUrlSyntax(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      url.hostname.length === 0 ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home.arpa") ||
      isIP(hostname) !== 0
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const firstGroup = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
    return !(
      !Number.isInteger(firstGroup) ||
      firstGroup < 0x2000 ||
      firstGroup > 0x3fff ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("2001:0:") ||
      normalized.startsWith("2001:1:") ||
      normalized.startsWith("2002:") ||
      normalized.startsWith("3fff:") ||
      normalized.startsWith("64:ff9b:")
    );
  }
  return false;
}

async function defaultLookup(hostname: string): Promise<readonly BrowserAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

function invalidUrl(): BrowserGuestError {
  return new BrowserGuestError("BROWSER_URL_INVALID", "Enter a public HTTPS website address.");
}
