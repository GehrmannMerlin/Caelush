import { createHash } from "node:crypto";
import path from "node:path";
import {
  type ReadOnlyResourceGrant,
  type ReadOnlyResourceIdentity,
  type ReadOnlyResourcePolicy,
  type RunId,
} from "@caelush/protocol";

export const MAX_READ_ONLY_RESOURCE_GRANT_LIFETIME_MS = 60_000;
const issuedReadOnlyResourceGrants = new WeakSet<object>();

export type ReadOnlyResourceGrantDenialReason =
  | "RESOURCE_AUTHORITY_DISABLED"
  | "WRONG_RUN"
  | "RESOURCE_NOT_ALLOWED"
  | "INVALID_RESOURCE_IDENTITY"
  | "POLICY_EXPIRED"
  | "POLICY_REVOKED"
  | "GRANT_EXPIRED"
  | "UNTRUSTED_GRANT";

export type ReadOnlyResourceGrantDecision =
  | { readonly kind: "ALLOW"; readonly grant: ReadOnlyResourceGrant }
  | { readonly kind: "DENY"; readonly reason: ReadOnlyResourceGrantDenialReason };

export type ReadOnlyResourceGrantVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: ReadOnlyResourceGrantDenialReason };

/** Host-only request. The model supplies only a binding identifier, never this resource identity. */
export interface ReadOnlyResourceAuthorizationRequest extends ReadOnlyResourceIdentity {
  readonly runId: RunId;
}

/**
 * Issue a grant only when the exact immutable resource remains in the current Run policy.
 * The returned branded object is process-local; no DTO schema is provided for it.
 */
export function authorizeReadOnlyResource(
  request: ReadOnlyResourceAuthorizationRequest,
  currentPolicy: ReadOnlyResourcePolicy,
  now: number,
): ReadOnlyResourceGrantDecision {
  if (currentPolicy === null || typeof currentPolicy !== "object") {
    return deny("INVALID_RESOURCE_IDENTITY");
  }
  if (request === null || typeof request !== "object") {
    return deny("INVALID_RESOURCE_IDENTITY");
  }
  if (currentPolicy.enabled !== true) {
    return deny("RESOURCE_AUTHORITY_DISABLED");
  }
  if (request.runId !== currentPolicy.runId) return deny("WRONG_RUN");
  if (!validRevision(currentPolicy.revision)) return deny("INVALID_RESOURCE_IDENTITY");
  if (!Array.isArray(currentPolicy.resources)) return deny("INVALID_RESOURCE_IDENTITY");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(currentPolicy.expiresAt) ||
    currentPolicy.expiresAt <= now
  ) {
    return deny("POLICY_EXPIRED");
  }

  const identity = normalizeIdentity(request);
  if (identity === undefined) return deny("INVALID_RESOURCE_IDENTITY");
  const matchingResources = currentPolicy.resources.filter((resource) =>
    identitiesEqual(identity, normalizeIdentity(resource)),
  );
  if (matchingResources.length !== 1) return deny("RESOURCE_NOT_ALLOWED");

  const lifetime = Object.freeze({
    issuedAt: now,
    expiresAt: Math.min(now + MAX_READ_ONLY_RESOURCE_GRANT_LIFETIME_MS, currentPolicy.expiresAt),
  });
  const grantIdentity = {
    runId: currentPolicy.runId,
    resourceId: identity.resourceId,
    bundleRevision: identity.bundleRevision,
    canonicalRoot: identity.canonicalRoot,
    policyRevision: currentPolicy.revision,
    contentManifestHash: identity.contentManifestHash,
    lifetime,
  };
  return Object.freeze({
    kind: "ALLOW" as const,
    grant: issueGrant({
      ...grantIdentity,
      authorityFingerprint: fingerprintGrant(grantIdentity),
    }),
  });
}

/** Recheck an issued grant against the current Run policy immediately before Runtime dispatch. */
export function verifyReadOnlyResourceGrant(
  value: unknown,
  currentPolicy: ReadOnlyResourcePolicy,
  now: number,
): ReadOnlyResourceGrantVerification {
  if (!isIssuedGrant(value)) {
    return invalid("UNTRUSTED_GRANT");
  }
  if (currentPolicy === null || typeof currentPolicy !== "object") {
    return invalid("INVALID_RESOURCE_IDENTITY");
  }
  const grant = value;
  if (grant.runId !== currentPolicy.runId) return invalid("WRONG_RUN");
  if (!currentPolicy.enabled) return invalid("RESOURCE_AUTHORITY_DISABLED");
  if (grant.policyRevision !== currentPolicy.revision) return invalid("POLICY_REVOKED");
  if (!validRevision(currentPolicy.revision)) return invalid("INVALID_RESOURCE_IDENTITY");
  if (!Array.isArray(currentPolicy.resources)) return invalid("INVALID_RESOURCE_IDENTITY");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(currentPolicy.expiresAt) ||
    currentPolicy.expiresAt <= now
  ) {
    return invalid("POLICY_EXPIRED");
  }
  if (
    !Number.isSafeInteger(grant.lifetime.issuedAt) ||
    !Number.isSafeInteger(grant.lifetime.expiresAt) ||
    grant.lifetime.issuedAt > now ||
    grant.lifetime.expiresAt <= now ||
    grant.lifetime.expiresAt > currentPolicy.expiresAt ||
    grant.lifetime.expiresAt - grant.lifetime.issuedAt > MAX_READ_ONLY_RESOURCE_GRANT_LIFETIME_MS
  ) {
    return invalid("GRANT_EXPIRED");
  }
  const identity = normalizeIdentity(grant);
  if (identity === undefined) return invalid("INVALID_RESOURCE_IDENTITY");
  const matchingResources = currentPolicy.resources.filter((resource) =>
    identitiesEqual(identity, normalizeIdentity(resource)),
  );
  if (matchingResources.length !== 1) return invalid("POLICY_REVOKED");
  const grantIdentity = {
    runId: grant.runId,
    resourceId: identity.resourceId,
    bundleRevision: identity.bundleRevision,
    canonicalRoot: identity.canonicalRoot,
    policyRevision: grant.policyRevision,
    contentManifestHash: identity.contentManifestHash,
    lifetime: grant.lifetime,
  };
  if (fingerprintGrant(grantIdentity) !== grant.authorityFingerprint) {
    return invalid("UNTRUSTED_GRANT");
  }
  return Object.freeze({ valid: true as const });
}

function normalizeIdentity(value: unknown): ReadOnlyResourceIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !validRevision(candidate.resourceId) ||
    !validRevision(candidate.bundleRevision) ||
    typeof candidate.contentManifestHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.contentManifestHash) ||
    typeof candidate.canonicalRoot !== "string"
  ) {
    return undefined;
  }
  const root = normalizeAbsolutePath(candidate.canonicalRoot);
  if (root === undefined || root !== candidate.canonicalRoot.replaceAll("\\", "/")) {
    return undefined;
  }
  return Object.freeze({
    resourceId: candidate.resourceId,
    bundleRevision: candidate.bundleRevision,
    canonicalRoot: root,
    contentManifestHash: candidate.contentManifestHash,
  });
}

function normalizeAbsolutePath(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
  const windowsPath = path.win32.isAbsolute(value);
  const posixPath = path.posix.isAbsolute(value);
  if (!windowsPath && !posixPath) return undefined;
  const normalized = windowsPath ? path.win32.normalize(value) : path.posix.normalize(value);
  return normalized.replaceAll("\\", "/");
}

function identitiesEqual(
  left: ReadOnlyResourceIdentity,
  right: ReadOnlyResourceIdentity | undefined,
): boolean {
  return (
    right !== undefined &&
    left.resourceId === right.resourceId &&
    left.bundleRevision === right.bundleRevision &&
    left.canonicalRoot === right.canonicalRoot &&
    left.contentManifestHash === right.contentManifestHash
  );
}

function fingerprintGrant(identity: {
  readonly runId: RunId;
  readonly resourceId: string;
  readonly bundleRevision: string;
  readonly canonicalRoot: string;
  readonly policyRevision: string;
  readonly contentManifestHash: string;
}): string {
  const value = JSON.stringify([
    "caelush-read-only-resource-grant-v1",
    identity.runId,
    identity.resourceId,
    identity.bundleRevision,
    identity.canonicalRoot,
    identity.policyRevision,
    identity.contentManifestHash,
  ]);
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function issueGrant(
  grant: ReadOnlyResourceIdentity & {
    readonly runId: RunId;
    readonly policyRevision: string;
    readonly lifetime: { readonly issuedAt: number; readonly expiresAt: number };
    readonly authorityFingerprint: string;
  },
): ReadOnlyResourceGrant {
  const issued = { ...grant } as ReadOnlyResourceGrant;
  Object.freeze(issued.lifetime);
  Object.freeze(issued);
  issuedReadOnlyResourceGrants.add(issued);
  return issued;
}

function isIssuedGrant(value: unknown): value is ReadOnlyResourceGrant {
  return value !== null && typeof value === "object" && issuedReadOnlyResourceGrants.has(value);
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function deny(reason: ReadOnlyResourceGrantDenialReason): ReadOnlyResourceGrantDecision {
  return Object.freeze({ kind: "DENY" as const, reason });
}

function invalid(reason: ReadOnlyResourceGrantDenialReason): ReadOnlyResourceGrantVerification {
  return Object.freeze({ valid: false as const, reason });
}
