import { createGitStatusTool, createRuntimeGitOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import {
  DEFINITION_ONLY_RUNTIME_RESOLVER,
  toLegacyToolRegistration,
  toolDefinitionFromCodingTool,
} from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `git_status` — a thin compatibility facade over the Coding product layer.
 *
 * `path` is a real Git pathspec and `limit` drives Runtime status parsing; neither can be
 * reconstructed after the invocation, because Git's pathspec semantics include glob and `:(magic)`
 * forms no string filter reproduces. The corrected `GitOperations.status` contract carries both, and
 * the Tool passes a canonical `{ path?, limit }` bag that the adapter forwards to
 * `RuntimeGitService` — **Git itself** applies the pathspec inside `git status -- <path>`.
 *
 * No pathspec interpretation, no `startsWith`, no glob matching and no limit defaulting exists in
 * this module. `limit` above the Runtime's own default of 200 also survives, because the target Tool
 * passes the caller's value through.
 */
export function createGitStatusRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeGitOperations(runtimeResolver);
  return toLegacyToolRegistration(createGitStatusTool(operations));
}

/**
 * The `git_status` data description, for the legacy public export surface.
 *
 * A projection of the target Tool's own schema and Coding security metadata.
 */
export const gitStatusDefinition = toolDefinitionFromCodingTool(
  createGitStatusTool(createRuntimeGitOperations(DEFINITION_ONLY_RUNTIME_RESOLVER)),
);
