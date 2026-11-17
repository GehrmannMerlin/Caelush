import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  FilesystemBoundarySchema,
  ProcessBoundarySchema,
  RequiredEnforcementSchema,
  type FilesystemBoundary,
  type ProcessBoundary,
  type RequiredEnforcement,
  type ReadOnlyResourceGrant,
  type ReadOnlyResourceIdentity,
  type ReadOnlyResourcePolicy,
  type RunId,
  type WorkspaceId,
} from "@caelush/protocol";
import {
  RuntimeAuthorizationError,
  RuntimeWorkspaceBoundaryMismatchError,
} from "../runtime-errors.js";
import type { ProcessSandboxProvider } from "../sandbox/contracts.js";

export interface RuntimeFilesystemPolicy {
  readonly workspaceId: WorkspaceId;
  readonly workspaceRoot: string;
  readonly hostUserRoot: string;
  readonly boundary: FilesystemBoundary;
  readonly protectedRoots: readonly string[];
  readonly readOnlyResources?: ReadOnlyResourcePolicy;
}

export interface RuntimeProcessPolicy {
  readonly runId: RunId;
  readonly filesystem: RuntimeFilesystemPolicy;
  readonly processBoundary: ProcessBoundary;
  readonly requiredEnforcement: RequiredEnforcement;
}

export interface AuthorizedRuntimeExecution {
  readonly runId: RunId;
  readonly policy: RuntimeProcessPolicy;
  readonly provider: ProcessSandboxProvider;
  readonly authorizationNonce: string;
}

export interface RuntimeProcessPolicyInput {
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceRoot: string;
  readonly filesystemBoundary: FilesystemBoundary;
  readonly processBoundary: ProcessBoundary;
  readonly requiredEnforcement: RequiredEnforcement;
  readonly hostUserRoot?: string;
  readonly protectedRoots?: readonly string[];
  readonly readOnlyResources?: ReadOnlyResourcePolicy;
}

export interface RuntimeFilesystemPolicyInput {
  readonly workspaceId: WorkspaceId;
  readonly workspaceRoot: string;
  readonly boundary: FilesystemBoundary;
  readonly hostUserRoot?: string;
  readonly protectedRoots?: readonly string[];
  readonly readOnlyResources?: ReadOnlyResourcePolicy;
}

export function createRuntimeFilesystemPolicy(
  input: RuntimeFilesystemPolicyInput,
): RuntimeFilesystemPolicy {
  if (
    !FilesystemBoundarySchema.safeParse(input.boundary).success ||
    typeof input.workspaceRoot !== "string" ||
    !path.isAbsolute(input.workspaceRoot) ||
    input.workspaceRoot.includes("\0")
  ) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime filesystem policy is invalid.");
  }
  const workspaceRoot = path.normalize(input.workspaceRoot);
  const hostUserRoot = path.normalize(input.hostUserRoot ?? os.homedir());
  if (!path.isAbsolute(hostUserRoot) || hostUserRoot.includes("\0")) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime host-user root is invalid.");
  }
  const protectedRoots = [...(input.protectedRoots ?? [])].map((root) => {
    if (!path.isAbsolute(root) || root.includes("\0")) {
      throw new RuntimeWorkspaceBoundaryMismatchError("Runtime protected root is invalid.");
    }
    return path.normalize(root);
  });
  const readOnlyResources =
    input.readOnlyResources === undefined
      ? undefined
      : normalizeReadOnlyResourcePolicy(input.readOnlyResources);
  return Object.freeze({
    workspaceId: input.workspaceId,
    workspaceRoot,
    hostUserRoot,
    boundary: input.boundary,
    protectedRoots: Object.freeze(protectedRoots),
    ...(readOnlyResources === undefined ? {} : { readOnlyResources }),
  });
}

export function createRuntimeProcessPolicy(input: RuntimeProcessPolicyInput): RuntimeProcessPolicy {
  if (
    !ProcessBoundarySchema.safeParse(input.processBoundary).success ||
    !RequiredEnforcementSchema.safeParse(input.requiredEnforcement).success ||
    typeof input.workspaceRoot !== "string" ||
    !path.isAbsolute(input.workspaceRoot) ||
    input.workspaceRoot.includes("\0")
  ) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime workspace policy is invalid.");
  }
  const filesystem = createRuntimeFilesystemPolicy({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    boundary: input.filesystemBoundary,
    ...(input.hostUserRoot === undefined ? {} : { hostUserRoot: input.hostUserRoot }),
    ...(input.protectedRoots === undefined ? {} : { protectedRoots: input.protectedRoots }),
    ...(input.readOnlyResources === undefined
      ? {}
      : { readOnlyResources: input.readOnlyResources }),
  });
  if (
    filesystem.readOnlyResources !== undefined &&
    filesystem.readOnlyResources.runId !== input.runId
  ) {
    throw new RuntimeAuthorizationError("Read-only resource policy belongs to a different Run.");
  }
  return Object.freeze({
    runId: input.runId,
    filesystem,
    processBoundary: input.processBoundary,
    requiredEnforcement: input.requiredEnforcement,
  });
}

export function createAuthorizedRuntimeExecution(input: {
  readonly policy: RuntimeProcessPolicy;
  readonly provider: ProcessSandboxProvider;
  readonly authorizationNonce: string;
}): AuthorizedRuntimeExecution {
  if (
    input.authorizationNonce.length < 8 ||
    input.authorizationNonce.length > 256 ||
    /[^A-Za-z0-9._:-]/.test(input.authorizationNonce) ||
    input.provider.id.length === 0
  ) {
    throw new RuntimeAuthorizationError("Runtime authorization nonce or provider is invalid.");
  }
  return Object.freeze({
    runId: input.policy.runId,
    policy: input.policy,
    provider: input.provider,
    authorizationNonce: input.authorizationNonce,
  });
}

export function assertAuthorizedRuntimeExecution(
  authorization: AuthorizedRuntimeExecution,
  ownerRunId: RunId,
  cwd: string,
  readOnlyResourceGrant?: ReadOnlyResourceGrant,
): void {
  if (authorization.runId !== ownerRunId) {
    throw new RuntimeAuthorizationError("Runtime authorization belongs to a different Run.");
  }
  if (!path.isAbsolute(cwd)) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime execution cwd must be absolute.");
  }
  assertRuntimeFilesystemBoundary(authorization.policy.filesystem, cwd);
  if (readOnlyResourceGrant !== undefined) {
    assertReadOnlyResourceGrant(authorization, ownerRunId, readOnlyResourceGrant);
  }
}

export function assertReadOnlyResourceGrant(
  authorization: AuthorizedRuntimeExecution,
  ownerRunId: RunId,
  grant: ReadOnlyResourceGrant,
): void {
  const authority = authorization.policy.filesystem.readOnlyResources;
  const now = Date.now();
  if (
    authority === undefined ||
    authority.runId !== ownerRunId ||
    authorization.runId !== ownerRunId ||
    grant.runId !== ownerRunId ||
    authority.enabled !== true ||
    authority.revision !== grant.policyRevision ||
    !Number.isSafeInteger(authority.expiresAt) ||
    authority.expiresAt <= now ||
    !Number.isSafeInteger(grant.lifetime.issuedAt) ||
    !Number.isSafeInteger(grant.lifetime.expiresAt) ||
    grant.lifetime.issuedAt > now ||
    grant.lifetime.expiresAt <= now ||
    grant.lifetime.expiresAt > authority.expiresAt ||
    grant.lifetime.expiresAt - grant.lifetime.issuedAt > 60_000 ||
    !/^[a-f0-9]{64}$/u.test(grant.authorityFingerprint)
  ) {
    throw new RuntimeAuthorizationError("The read-only resource grant is invalid or expired.");
  }
  const matches = authority.resources.filter((resource) => resourceMatches(resource, grant));
  if (matches.length !== 1 || readOnlyResourceFingerprint(grant) !== grant.authorityFingerprint) {
    throw new RuntimeAuthorizationError(
      "The read-only resource grant is not current for this Run.",
    );
  }
}

export function assertRuntimeFilesystemBoundary(
  policy: RuntimeFilesystemPolicy,
  candidatePath: string,
): void {
  if (!path.isAbsolute(candidatePath)) {
    throw new RuntimeWorkspaceBoundaryMismatchError();
  }
  const normalized = path.normalize(candidatePath);
  const insideWorkspace = isPathInsideOrEqual(policy.workspaceRoot, normalized);
  const insideHostUser =
    policy.boundary === "HOST_USER_SCOPE" && isPathInsideOrEqual(policy.hostUserRoot, normalized);
  if (!insideWorkspace && !insideHostUser) {
    throw new RuntimeWorkspaceBoundaryMismatchError();
  }
}

export function assertRuntimeWorkspaceBoundary(
  policy: RuntimeProcessPolicy,
  candidatePath: string,
): void {
  if (
    !path.isAbsolute(candidatePath) ||
    !isPathInsideOrEqual(policy.filesystem.workspaceRoot, path.normalize(candidatePath))
  ) {
    throw new RuntimeWorkspaceBoundaryMismatchError();
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeReadOnlyResourcePolicy(input: ReadOnlyResourcePolicy): ReadOnlyResourcePolicy {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.runId !== "string" ||
    typeof input.revision !== "string" ||
    input.revision.length === 0 ||
    input.revision.length > 256 ||
    typeof input.enabled !== "boolean" ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Array.isArray(input.resources) ||
    input.resources.length > 64
  ) {
    throw new RuntimeAuthorizationError("The read-only resource policy is invalid.");
  }
  const resources = input.resources.map((resource) => normalizeResourceIdentity(resource));
  if (new Set(resources.map((resource) => resource.resourceId)).size !== resources.length) {
    throw new RuntimeAuthorizationError("The read-only resource policy has duplicate identities.");
  }
  return Object.freeze({
    runId: input.runId,
    revision: input.revision,
    enabled: input.enabled,
    expiresAt: input.expiresAt,
    resources: Object.freeze(resources),
  });
}

function normalizeResourceIdentity(input: ReadOnlyResourceIdentity): ReadOnlyResourceIdentity {
  if (
    input === null ||
    typeof input !== "object" ||
    !validIdentityField(input.resourceId) ||
    !validIdentityField(input.bundleRevision) ||
    typeof input.contentManifestHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.contentManifestHash) ||
    typeof input.canonicalRoot !== "string" ||
    !path.isAbsolute(input.canonicalRoot) ||
    input.canonicalRoot.includes("\0")
  ) {
    throw new RuntimeAuthorizationError("The read-only resource identity is invalid.");
  }
  return Object.freeze({
    resourceId: input.resourceId,
    bundleRevision: input.bundleRevision,
    canonicalRoot: path.normalize(input.canonicalRoot).replaceAll("\\", "/"),
    contentManifestHash: input.contentManifestHash,
  });
}

function validIdentityField(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}

function resourceMatches(
  resource: ReadOnlyResourceIdentity,
  grant: ReadOnlyResourceGrant,
): boolean {
  return (
    resource.resourceId === grant.resourceId &&
    resource.bundleRevision === grant.bundleRevision &&
    resource.canonicalRoot === grant.canonicalRoot &&
    resource.contentManifestHash === grant.contentManifestHash
  );
}

function readOnlyResourceFingerprint(grant: ReadOnlyResourceGrant): string {
  const identity = JSON.stringify([
    "caelush-read-only-resource-grant-v1",
    grant.runId,
    grant.resourceId,
    grant.bundleRevision,
    grant.canonicalRoot,
    grant.policyRevision,
    grant.contentManifestHash,
  ]);
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
