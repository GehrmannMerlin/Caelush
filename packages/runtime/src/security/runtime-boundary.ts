import path from "node:path";
import {
  FilesystemBoundarySchema,
  ProcessBoundarySchema,
  RequiredEnforcementSchema,
  type FilesystemBoundary,
  type ProcessBoundary,
  type RequiredEnforcement,
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
  readonly boundary: FilesystemBoundary;
  readonly protectedRoots: readonly string[];
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
  readonly protectedRoots?: readonly string[];
}

export function createRuntimeProcessPolicy(input: RuntimeProcessPolicyInput): RuntimeProcessPolicy {
  if (
    !FilesystemBoundarySchema.safeParse(input.filesystemBoundary).success ||
    !ProcessBoundarySchema.safeParse(input.processBoundary).success ||
    !RequiredEnforcementSchema.safeParse(input.requiredEnforcement).success ||
    typeof input.workspaceRoot !== "string" ||
    !path.isAbsolute(input.workspaceRoot) ||
    input.workspaceRoot.includes("\0")
  ) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime workspace policy is invalid.");
  }
  const workspaceRoot = path.normalize(input.workspaceRoot);
  const protectedRoots = [...(input.protectedRoots ?? [workspaceRoot])].map((root) => {
    if (!path.isAbsolute(root) || root.includes("\0")) {
      throw new RuntimeWorkspaceBoundaryMismatchError("Runtime protected root is invalid.");
    }
    return path.normalize(root);
  });
  return Object.freeze({
    runId: input.runId,
    filesystem: Object.freeze({
      workspaceId: input.workspaceId,
      workspaceRoot,
      boundary: input.filesystemBoundary,
      protectedRoots: Object.freeze(protectedRoots),
    }),
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
): void {
  if (authorization.runId !== ownerRunId) {
    throw new RuntimeAuthorizationError("Runtime authorization belongs to a different Run.");
  }
  if (!path.isAbsolute(cwd)) {
    throw new RuntimeWorkspaceBoundaryMismatchError("Runtime execution cwd must be absolute.");
  }
  assertRuntimeWorkspaceBoundary(authorization.policy, cwd);
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
