export interface UpdatePolicyPayload {
  readonly schemaVersion: 1;
  readonly product: "caelush";
  readonly platform: "windows";
  readonly arch: "x64";
  readonly channel: "dev" | "beta" | "stable";
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly minimumSupportedVersion: string;
  readonly mandatory: boolean;
  readonly graceDeadline: string | null;
  readonly revision: number;
  readonly release: {
    readonly version: string;
    readonly artifactUrl: string;
    readonly artifactSize: number;
    readonly sha512: string;
    readonly releaseNotes: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keyId: string;
}
export interface VerifiedUpdatePolicy {
  readonly payload: UpdatePolicyPayload;
  readonly canonicalPayload: string;
  readonly canonicalBytes: Buffer;
  readonly digestSha256: string;
}
export class PolicyContractError extends Error {
  readonly code: string;
}
export function canonicalizePolicyJson(value: unknown): string;
export function parsePolicyJson(source: string): unknown;
export function validateUpdatePolicyPayload(payload: unknown): UpdatePolicyPayload;
export function verifySignedUpdatePolicy(
  input: string,
  options: {
    readonly publicKeys: Record<string, string | Buffer>;
    readonly allowedReleaseHosts: readonly string[];
    readonly now?: number;
    readonly acceptedPolicy?: { readonly revision: number; readonly digestSha256: string };
  },
): VerifiedUpdatePolicy;
