import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import {
  canonicalizePolicyJson,
  parsePolicyJson,
  verifySignedUpdatePolicy,
  type VerifiedUpdatePolicy,
} from "../../shared/signed-update-policy.mjs";
import { DesktopUpdateError } from "../update/error.js";
export interface UpdateTrust {
  readonly publicKeys: Record<string, string | Buffer>;
  readonly allowedReleaseHosts: readonly string[];
  readonly channel: "dev" | "beta" | "stable";
  /** Build-pinned in internal-test clients; never Renderer or response options. */
  readonly internalTestCa?: string;
  readonly internalTestLoopback?: boolean;
}
export interface AcceptedPolicy {
  readonly revision: number;
  readonly digestSha256: string;
}
export interface PolicyResponse extends VerifiedUpdatePolicy {
  readonly responseJson: string;
}
export function verifyPolicyResponse(
  raw: string,
  trust: UpdateTrust,
  currentVersion: string,
  acceptedPolicy?: AcceptedPolicy,
  now?: number,
): PolicyResponse {
  const response = z
    .object({ requestId: z.uuid(), signedPolicy: z.unknown() })
    .strict()
    .parse(parsePolicyJson(raw));
  const verified = verifySignedUpdatePolicy(canonicalizePolicyJson(response.signedPolicy), {
    publicKeys: trust.publicKeys,
    allowedReleaseHosts: trust.allowedReleaseHosts,
    ...(acceptedPolicy ? { acceptedPolicy } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  if (
    verified.payload.channel !== trust.channel ||
    verified.payload.currentVersion !== currentVersion
  ) {
    throw new DesktopUpdateError(
      "POLICY_REQUEST_MISMATCH",
      "The signed policy does not match this application's channel and version.",
    );
  }
  return Object.freeze({ ...verified, responseJson: raw });
}
type Transport = (url: URL, signal: AbortSignal) => Promise<{ status: number; body: string }>;
export class UpdatePolicyClient {
  constructor(
    private readonly origin: string,
    private readonly trust: UpdateTrust,
    private readonly version: string,
    private readonly transport: Transport = requestPolicy,
  ) {}
  async check(signal: AbortSignal = new AbortController().signal): Promise<PolicyResponse | null> {
    if (
      Object.keys(this.trust.publicKeys).length === 0 ||
      this.trust.allowedReleaseHosts.length === 0
    ) {
      throw new DesktopUpdateError(
        "UPDATE_TRUST_UNCONFIGURED",
        "Update trust is not configured in this Desktop build.",
      );
    }
    const url = new URL("/v1/desktop/update-policy", this.origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
      throw new DesktopUpdateError(
        "POLICY_ORIGIN_INVALID",
        "The build's update service origin is invalid.",
      );
    }
    url.search = new URLSearchParams({
      platform: "windows",
      arch: "x64",
      channel: this.trust.channel,
      currentVersion: this.version,
    }).toString();
    const response = await this.transport(url, signal);
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new DesktopUpdateError(
        `POLICY_HTTP_${response.status}`,
        "The update policy service did not return an available policy. Retry later.",
      );
    return verifyPolicyResponse(response.body, this.trust, this.version);
  }
}
function requestPolicy(url: URL, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        req.destroy(
          new DesktopUpdateError("POLICY_TIMEOUT", "The update policy request timed out."),
        ),
      15000,
    );
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal,
        headers: { accept: "application/json", "accept-encoding": "identity" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024)
            req.destroy(
              new DesktopUpdateError(
                "POLICY_RESPONSE_TOO_LARGE",
                "The policy response exceeded its size limit.",
              ),
            );
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (!res.complete) {
            reject(
              new DesktopUpdateError("POLICY_TRUNCATED", "The policy response was incomplete."),
            );
            return;
          }
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
            });
          } catch {
            reject(
              new DesktopUpdateError(
                "POLICY_JSON_INVALID",
                "The policy response is not valid UTF-8.",
              ),
            );
          }
        });
      },
    );
    req.once("error", reject);
    req.once("close", () => clearTimeout(timer));
    req.end();
  });
}
