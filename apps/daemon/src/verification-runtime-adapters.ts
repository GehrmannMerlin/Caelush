import { createRunSecurityContext } from "@caelush/core";
import type { AgentRun, RunId } from "@caelush/protocol";
import {
  RuntimeBinaryFileError,
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  RuntimeGitError,
  RuntimeSandboxError,
  createAuthorizedRuntimeExecution,
  createRuntimeProcessPolicy,
  createUnrestrictedProcessSandboxProvider,
  type LocalRuntime,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
import { classifySensitivePath, verificationEvidenceSanitizer } from "@caelush/security";
import type {
  VerificationGitPort,
  VerificationGitStatus,
  WorkspaceArtifactEvidence,
  WorkspaceContentFingerprint,
  WorkspaceInspectionFacts,
  WorkspacePathObservation,
  WorkspaceVerificationPort,
  VerificationCommandExecutionPort,
  VerificationRuntimeArgvRequest,
  VerificationRuntimeProcessInteractionRequest,
} from "@caelush/verification";
import {
  MAX_WORKSPACE_ARTIFACT_FILE_BYTES,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
} from "@caelush/verification";

export function createRuntimeWorkspaceVerificationPort(
  scope: Pick<RuntimeWorkspaceScope, "pathResolver"> &
    Partial<Pick<RuntimeWorkspaceScope, "filesystem">>,
): WorkspaceVerificationPort {
  return {
    async inspect(input) {
      const paths = new Map<string, WorkspacePathObservation>();
      const artifacts: WorkspaceArtifactEvidence[] = [];
      let artifactContentBytes = 0;
      for (const changedFile of [...input.changedFiles].sort(compareChangedFiles)) {
        if (input.signal?.aborted) throw new Error("workspace inspection aborted");
        try {
          const resolved = await scope.pathResolver.resolveExisting(changedFile.path);
          let fingerprint =
            scope.filesystem === undefined
              ? undefined
              : await scope.filesystem.fingerprint(resolved.absolutePath);
          if (
            scope.filesystem !== undefined &&
            resolved.kind === "FILE" &&
            fingerprint?.kind === "FILE"
          ) {
            const artifact = await inspectArtifact({
              path: changedFile.path,
              absolutePath: resolved.absolutePath,
              fingerprint,
              filesystem: scope.filesystem,
              contentBytes: artifactContentBytes,
            });
            artifacts.push(artifact.evidence);
            fingerprint = artifact.fingerprint;
            artifactContentBytes += artifact.contentBytes;
          }
          paths.set(changedFile.path, {
            path: changedFile.path,
            kind: resolved.kind,
            ...(fingerprint === undefined ? {} : { fingerprint }),
          });
        } catch (error) {
          if (error instanceof RuntimePathNotFoundError) {
            paths.set(changedFile.path, {
              path: changedFile.path,
              kind: "MISSING",
              ...(changedFile.changeType === "DELETED"
                ? { fingerprint: { kind: "MISSING" as const } }
                : {}),
            });
          } else if (error instanceof RuntimeBoundaryError) {
            paths.set(changedFile.path, { path: changedFile.path, kind: "OUTSIDE" });
          } else {
            paths.set(changedFile.path, { path: changedFile.path, kind: "ERROR" });
          }
        }
      }
      const facts: WorkspaceInspectionFacts = {
        inspectionComplete: true,
        paths: [...paths.values()].sort((left, right) => left.path.localeCompare(right.path)),
        ...(artifacts.length === 0
          ? {}
          : {
              artifactEvidence: artifacts.sort((left, right) =>
                left.path.localeCompare(right.path),
              ),
            }),
      };
      return facts;
    },
  };
}

/**
 * Bind verification's argv execution to the persisted Run security snapshot.
 *
 * Verification is not a privileged side door around Tool admission. It is a host-owned execution
 * client, so it uses the same Runtime authorization object as a process Tool: the Run snapshot is
 * verified, the workspace policy is rebuilt from the model-free workspace locator, and the Runtime's
 * authorized argv entry point is the only method used for a new process. Restricted Runs fail closed
 * until the daemon's probed restricted-provider capability is available; they never fall back to an
 * ordinary spawn.
 */
export function createRunBoundVerificationExecution(
  runtime: LocalRuntime,
  runs: Pick<{ get(runId: RunId): Promise<AgentRun | null> }, "get">,
): VerificationCommandExecutionPort {
  return {
    async executeArgv(input: VerificationRuntimeArgvRequest) {
      const { scope, authorization } = await openAuthorizedVerificationScope(
        runtime,
        runs,
        input.ownerRunId,
      );
      return scope.exec.executeArgvAuthorized({ ...input, authorization });
    },
    async interact(input: VerificationRuntimeProcessInteractionRequest) {
      const { scope } = await openAuthorizedVerificationScope(runtime, runs, input.ownerRunId);
      return scope.exec.interact(input);
    },
  };
}

async function openAuthorizedVerificationScope(
  runtime: LocalRuntime,
  runs: Pick<{ get(runId: RunId): Promise<AgentRun | null> }, "get">,
  ownerRunId: RunId,
): Promise<{
  readonly scope: RuntimeWorkspaceScope;
  readonly authorization: import("@caelush/runtime").AuthorizedRuntimeExecution;
}> {
  const run = await runs.get(ownerRunId);
  if (run === null) throw new RuntimeSandboxError("Verification Run is unavailable.");
  const security = createRunSecurityContext(run.securityPolicy);
  if (
    security.processBoundary !== "UNRESTRICTED" ||
    security.filesystemBoundary !== "HOST_USER_SCOPE" ||
    security.requiredEnforcement !== "HARD_SAFETY_ONLY"
  ) {
    throw new RuntimeSandboxError(
      "The required restricted verification process sandbox is unavailable.",
    );
  }
  const policy = createRuntimeProcessPolicy({
    runId: run.id,
    workspaceId: run.workspace.id,
    workspaceRoot: run.workspace.path,
    filesystemBoundary: security.filesystemBoundary,
    processBoundary: security.processBoundary,
    requiredEnforcement: security.requiredEnforcement,
  });
  const authorization = createAuthorizedRuntimeExecution({
    policy,
    provider: createUnrestrictedProcessSandboxProvider(),
    authorizationNonce: `${run.id}:${security.policyDigest}:verification`,
  });
  const scope = await runtime.openWorkspace(run.workspace, {
    filesystemPolicy: policy.filesystem,
    processAuthorization: authorization,
  });
  return { scope, authorization };
}

async function inspectArtifact(input: {
  readonly path: string;
  readonly absolutePath: string;
  readonly fingerprint: WorkspaceContentFingerprint;
  readonly filesystem: RuntimeWorkspaceScope["filesystem"];
  readonly contentBytes: number;
}): Promise<{
  readonly evidence: WorkspaceArtifactEvidence;
  readonly fingerprint: WorkspaceContentFingerprint;
  readonly contentBytes: number;
}> {
  const metadata = {
    path: input.path,
    ...(input.fingerprint.sha256 === undefined ? {} : { sha256: input.fingerprint.sha256 }),
    ...(input.fingerprint.sizeBytes === undefined
      ? {}
      : { sizeBytes: input.fingerprint.sizeBytes }),
  };
  if (classifySensitivePath(input.path) !== undefined) {
    return {
      evidence: { ...metadata, kind: "SENSITIVE", truncated: false },
      fingerprint: input.fingerprint,
      contentBytes: 0,
    };
  }
  if (input.contentBytes >= MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) {
    return {
      evidence: { ...metadata, kind: "UNAVAILABLE", truncated: true },
      fingerprint: input.fingerprint,
      contentBytes: 0,
    };
  }
  try {
    const read = await input.filesystem.readTextFile(input.absolutePath, {
      offset: 0,
      limit: 256,
      maxBytes: MAX_WORKSPACE_ARTIFACT_FILE_BYTES,
    });
    const refreshed = await input.filesystem.fingerprint(input.absolutePath);
    if (!sameFingerprint(input.fingerprint, refreshed)) {
      return {
        evidence: {
          path: input.path,
          ...(refreshed.sha256 === undefined ? {} : { sha256: refreshed.sha256 }),
          ...(refreshed.sizeBytes === undefined ? {} : { sizeBytes: refreshed.sizeBytes }),
          kind: "UNAVAILABLE",
          truncated: true,
        },
        fingerprint: refreshed,
        contentBytes: 0,
      };
    }
    const redacted = verificationEvidenceSanitizer.redactText(read.lines.join("\n"));
    const bounded = verificationEvidenceSanitizer.boundText(
      redacted,
      Math.min(
        MAX_WORKSPACE_ARTIFACT_FILE_BYTES,
        MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES - input.contentBytes,
      ),
    );
    return {
      evidence: {
        ...metadata,
        kind: "TEXT",
        content: bounded.text,
        truncated: read.truncated || bounded.truncated,
      },
      fingerprint: refreshed,
      contentBytes: Buffer.byteLength(bounded.text, "utf8"),
    };
  } catch (error) {
    if (error instanceof RuntimeBinaryFileError) {
      return {
        evidence: { ...metadata, kind: "BINARY", truncated: false },
        fingerprint: input.fingerprint,
        contentBytes: 0,
      };
    }
    return {
      evidence: { ...metadata, kind: "UNAVAILABLE", truncated: false },
      fingerprint: input.fingerprint,
      contentBytes: 0,
    };
  }
}

function sameFingerprint(
  left: WorkspaceContentFingerprint,
  right: WorkspaceContentFingerprint,
): boolean {
  return (
    left.kind === right.kind && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256
  );
}

function compareChangedFiles(
  left: { readonly path: string; readonly changeType: string },
  right: { readonly path: string; readonly changeType: string },
): number {
  return left.path.localeCompare(right.path) || left.changeType.localeCompare(right.changeType);
}

export function createRuntimeGitVerificationPort(
  scope: Pick<RuntimeWorkspaceScope, "git">,
): VerificationGitPort {
  return {
    async status(input) {
      try {
        const result = await scope.git.status({
          limit: 1_000,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const status: VerificationGitStatus = { available: true, ...result };
        return status;
      } catch (error) {
        if (
          error instanceof RuntimeGitError &&
          (error.code === "NOT_A_GIT_REPOSITORY" || error.code === "GIT_UNAVAILABLE")
        ) {
          return { available: false };
        }
        throw error;
      }
    },
    async diff(input) {
      const result = await scope.git.diff({
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return result;
    },
  };
}
