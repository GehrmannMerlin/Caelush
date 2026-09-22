import { createFindFilesTool, createRuntimeReadOnlyOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { toLegacyToolRegistration } from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `find_files` — a thin compatibility facade over the Coding product layer.
 *
 * Glob validation, the pattern byte bound, the traversal refusal and the `INVALID_PATTERN` mapping are
 * all Coding Tool business rules. They live in `@caelush/coding-agent`, and this module reads them
 * back out of the returned `CodingToolDefinition` rather than restating them.
 *
 * The Tool also needs `findWithRoot` (the resolved root that `details.path` reports), which is part of
 * the same-package read-only superset the target owns.
 */
export function createFindFilesRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeReadOnlyOperations(runtimeResolver);
  return toLegacyToolRegistration(createFindFilesTool(operations));
}
