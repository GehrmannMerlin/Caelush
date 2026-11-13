declare module "*scripts/contracts/check-cloud-openapi.mjs" {
  export const DEFAULT_CLOUD_OPENAPI_PATH: string;
  export const REQUIRED_CLOUD_OPERATIONS: Readonly<
    Record<string, readonly (readonly [method: string, operationId: string])[]>
  >;
  export function validateCloudOpenApi(document: unknown): string[];
  export function compareCloudOpenApiContracts(baseline: unknown, candidate: unknown): string[];
}

declare module "*scripts/check-product-version.mjs" {
  export function auditProductVersions(options?: { root?: string }): Promise<{
    canonicalVersion: string | undefined;
    checkedManifestCount: number;
    releaseManifestCount: number;
    errors: string[];
  }>;
}

declare module "*scripts/contracts/semver.mjs" {
  export function compareSemVer(left: string, right: string): -1 | 0 | 1;
  export function isValidSemVer(version: unknown): boolean;
}

declare module "*scripts/contracts/signed-update-policy.mjs" {
  export class PolicyContractError extends Error {
    readonly code: string;
  }

  export function canonicalizePolicyJson(value: unknown): string;
  export function parsePolicyJson(source: string): unknown;
  export function validateUpdatePolicyPayload(payload: unknown): unknown;
  export function verifySignedUpdatePolicy(
    input: unknown,
    options: {
      publicKeys: Record<string, string> | Map<string, string>;
      allowedReleaseHosts: readonly string[];
      now?: number;
      acceptedPolicy?: { revision: number; digestSha256: string };
    },
  ): {
    payload: unknown;
    canonicalPayload: string;
    canonicalBytes: Uint8Array;
    digestSha256: string;
  };
}
