import { createListDirectoryTool, createRuntimeReadOnlyOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { toLegacyToolRegistration } from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `list_directory` — a thin compatibility facade over the Coding product layer.
 *
 * The Tool needs `listWithProbe`: the frozen `ListDirectoryOperations` port has no `offset`, so the
 * Tool asks for `offset - 1 + limit` entries and slices them itself while keeping `truncated`
 * provable. That same-package superset lives in `@caelush/coding-agent`
 * (`operations/coding-read-only-operations.ts`), not here — this file only wires the Runtime adapter
 * to the factory.
 *
 * No listing, ordering, `nextOffset`, `NOT_A_DIRECTORY` or truncation logic exists in this module.
 */
export function createListDirectoryRegistration(
  runtimeResolver: RuntimeResolver,
): ToolRegistration {
  const operations = createRuntimeReadOnlyOperations(runtimeResolver);
  return toLegacyToolRegistration(createListDirectoryTool(operations));
}
