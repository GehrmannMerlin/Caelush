import {
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  RuntimeGitError,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
import type {
  VerificationGitPort,
  VerificationGitStatus,
  WorkspaceInspectionFacts,
  WorkspacePathObservation,
  WorkspaceVerificationPort,
} from "@caelush/verification";

export function createRuntimeWorkspaceVerificationPort(
  scope: Pick<RuntimeWorkspaceScope, "pathResolver"> &
    Partial<Pick<RuntimeWorkspaceScope, "filesystem">>,
): WorkspaceVerificationPort {
  return {
    async inspect(input) {
      const paths = new Map<string, WorkspacePathObservation>();
      for (const changedFile of input.changedFiles) {
        if (input.signal?.aborted) throw new Error("workspace inspection aborted");
        try {
          const resolved = await scope.pathResolver.resolveExisting(changedFile.path);
          const fingerprint =
            scope.filesystem === undefined
              ? undefined
              : await scope.filesystem.fingerprint(resolved.absolutePath);
          paths.set(changedFile.path, {
            path: changedFile.path,
            kind: resolved.kind,
            ...(fingerprint === undefined ? {} : { fingerprint }),
          });
        } catch (error) {
          if (error instanceof RuntimePathNotFoundError) {
            paths.set(changedFile.path, { path: changedFile.path, kind: "MISSING" });
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
      };
      return facts;
    },
  };
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
