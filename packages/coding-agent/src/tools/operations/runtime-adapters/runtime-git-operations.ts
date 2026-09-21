import type { JsonObject } from "@caelush/ai";
import {
  RuntimeGitError,
  type GitDiffScope,
  type RuntimeGitService,
  type RuntimeResolver,
} from "@caelush/runtime";

import type { GitOperations } from "../operations.js";
import { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";

/**
 * The Runtime implementation of `GitOperations`.
 *
 * ```text
 * status({ args: { path?, limit } })   →  scope.git.status({ path?, limit, signal })
 * diff({ args: { scope?, path? } })    →  scope.git.diff({ scope?, path?, signal })
 * ```
 *
 * ## The pathspec is the Runtime's to interpret
 *
 * `args.path` is handed to `RuntimeGitService`, which resolves it lexically inside the workspace and
 * passes it to `git status -- <path>` / `git diff -- <path>`. This adapter does **not** filter entries,
 * match prefixes, or evaluate globs: Git's own pathspec semantics are the behaviour the Tools have
 * always had, and the only way to keep them is to let Git perform them.
 *
 * That is also why the corrected `status` arm carries `args` at all — a `status({ environment, signal })`
 * port had no channel for a pathspec, and a pathspec cannot be reconstructed after the invocation.
 *
 * ## The canonical argument shapes
 *
 * The frozen port types `args` as `JsonObject`, but the semantic shape is fixed and is produced by the
 * Coding Tool from **prepared, validated, defaulted** arguments — never from raw provider input:
 *
 * ```text
 * status   { path?: string; limit: number }
 * diff     { scope?: "WORKTREE" | "STAGED" | "ALL"; path?: string }
 * ```
 *
 * This adapter reads exactly those fields and ignores anything else, so a caller cannot smuggle a
 * Runtime option through the bag. A malformed value is raised as a `RuntimeGitError` with the Runtime's
 * own code, which the Coding Tool maps onto its safe failure vocabulary.
 */
function readOptionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RuntimeGitError("INVALID_GIT_PATH");
  return value;
}

function readRequiredLimit(args: JsonObject): number {
  const value = args.limit;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeGitError("INVALID_GIT_SCOPE");
  }
  return value;
}

function readDiffScope(args: JsonObject): GitDiffScope | undefined {
  const value = args.scope;
  if (value === undefined) return undefined;
  if (value !== "WORKTREE" && value !== "STAGED" && value !== "ALL") {
    throw new RuntimeGitError("INVALID_GIT_SCOPE");
  }
  return value;
}

function statusToJsonObject(result: Awaited<ReturnType<RuntimeGitService["status"]>>): JsonObject {
  return {
    ...(result.branch === undefined ? {} : { branch: result.branch }),
    detached: result.detached,
    ahead: result.ahead,
    behind: result.behind,
    clean: result.clean,
    entries: result.entries.map((entry) => ({ ...entry })),
    truncated: result.truncated,
  };
}

export function createRuntimeGitOperations(resolver: RuntimeResolver): GitOperations {
  return {
    async status(input) {
      const scope = await resolveRuntimeWorkspace(resolver, input.environment);
      const path = readOptionalString(input.args, "path");
      const limit = readRequiredLimit(input.args);
      const result = await scope.git.status({
        ...(path === undefined ? {} : { path }),
        limit,
        signal: input.signal,
      });
      return statusToJsonObject(result);
    },

    async diff(input) {
      const scope = await resolveRuntimeWorkspace(resolver, input.environment);
      const scopeName = readDiffScope(input.args);
      const path = readOptionalString(input.args, "path");
      const result = await scope.git.diff({
        ...(scopeName === undefined ? {} : { scope: scopeName }),
        ...(path === undefined ? {} : { path }),
        signal: input.signal,
      });
      return {
        scope: result.scope,
        path: result.path,
        diff: result.diff,
        truncated: result.truncated,
        bytesReturned: result.bytesReturned,
        omittedBytes: result.omittedBytes,
        hadDecodeReplacement: result.hadDecodeReplacement,
      };
    },
  };
}
