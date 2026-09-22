import { createApplyPatchTool, createRuntimePatchOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { toLegacyToolRegistration } from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `apply_patch` — a thin compatibility facade over the Coding product layer.
 *
 * The load-bearing part of this Tool is its **uncertain** boundary: `RuntimePatchUncertainError` must
 * become the canonical `ToolExecutionUncertainError` from `@caelush/agent`, never an ordinary
 * failure, or a model would patch again on top of a workspace whose state nobody observed. That
 * mapping, the mutation effect projector and the security facts all belong to the target factory, and
 * this module owns none of them.
 */
export function createApplyPatchRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimePatchOperations(runtimeResolver);
  return toLegacyToolRegistration(createApplyPatchTool(operations));
}
