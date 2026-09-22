import { createRuntimeReadOnlyOperations, createSearchTextTool } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { toLegacyToolRegistration } from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `search_text` — a thin compatibility facade over the Coding product layer.
 *
 * This Tool is why the round needed an errata, and the corrected semantics live entirely in
 * `@caelush/coding-agent`:
 *
 * ```text
 * include   reaches ripgrep as --glob, BEFORE truncation        Runtime pre-filter
 * limit     is the business-visible maximum; the Runtime is asked for limit + 1
 * truncated runtime.truncated OR raw match count > limit
 * ```
 *
 * A tool-side `include` post-filter would return `matches = []` with `truncated = true` for a file
 * that demonstrably contains the pattern, which is exactly the behaviour the corrected
 * `SearchTextOperations` contract exists to prevent. There is no filter, no bound and no truncation
 * rule in this module — only the wiring.
 */
export function createSearchTextRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeReadOnlyOperations(runtimeResolver);
  return toLegacyToolRegistration(createSearchTextTool(operations));
}
