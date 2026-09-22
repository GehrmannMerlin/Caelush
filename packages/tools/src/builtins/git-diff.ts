import { createGitDiffTool, createRuntimeGitOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import {
  DEFINITION_ONLY_RUNTIME_RESOLVER,
  toLegacyToolRegistration,
  toolDefinitionFromCodingTool,
} from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `git_diff` — a thin compatibility facade over the Coding product layer.
 *
 * `scope` validation, the `INVALID_GIT_SCOPE` / `INVALID_GIT_PATH` codes, the truncation and
 * decode-replacement reporting and the `GIT_DIFF` security facts all belong to the target factory.
 * `GitOperations.diff` already carried an `args` bag before the errata, so this arm needed no
 * contract correction; only its owner moved.
 */
export function createGitDiffRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeGitOperations(runtimeResolver);
  return toLegacyToolRegistration(createGitDiffTool(operations));
}

/**
 * The `git_diff` data description, for the legacy public export surface.
 *
 * A projection of the target Tool's own schema and Coding security metadata.
 */
export const gitDiffDefinition = toolDefinitionFromCodingTool(
  createGitDiffTool(createRuntimeGitOperations(DEFINITION_ONLY_RUNTIME_RESOLVER)),
);
