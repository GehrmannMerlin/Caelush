import { createReadFileTool, createRuntimeReadOnlyOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { toLegacyToolRegistration } from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `read_file` — a thin compatibility facade over the Coding product layer.
 *
 * ```text
 * RuntimeResolver
 *   → createRuntimeReadOnlyOperations(resolver)      the Runtime Operations adapter
 *   → createReadFileTool(operations.readFile)        the only implementation
 *   → toLegacyToolRegistration(definition)           the legacy view of it
 * ```
 *
 * There is no `read_file` business algorithm in this file: no offset bound, no byte ceiling, no
 * `NOT_A_FILE` mapping, no details shape and no effect projector. Every one of those is read out of
 * the `CodingToolDefinition` the target factory returned, so this module cannot drift from
 * `@caelush/coding-agent` — it has nothing to drift with.
 *
 * `createRuntimeReadOnlyOperations` returns one object implementing four narrow ports. This Tool's
 * factory is handed only `readFile`, which is why a `read_file` implementation that tried to call
 * `execute()` would not compile.
 */
export function createReadFileRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeReadOnlyOperations(runtimeResolver);
  return toLegacyToolRegistration(createReadFileTool(operations));
}
