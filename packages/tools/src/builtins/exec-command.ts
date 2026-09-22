import { createExecCommandTool, createRuntimeProcessOperations } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import {
  DEFINITION_ONLY_RUNTIME_RESOLVER,
  toLegacyToolRegistration,
  toolDefinitionFromCodingTool,
} from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `exec_command` — a thin compatibility facade over the Coding product layer.
 *
 * Two things about this Tool make the facade shape matter rather than being cosmetic:
 *
 * ```text
 * updates   the target execute publishes transient output through input.updates.publish(...)
 *           only the canonical execution input carries that sink, so the canonical AgentTool —
 *           not a legacy handler projection — has to be what the registry executes
 * uncertain a stale or uncertain process session must become ToolExecutionUncertainError,
 *           never a retryable failure
 * ```
 *
 * Both of those live in `@caelush/coding-agent` (`projectExecEffects`, the uncertain mapping, the
 * output bound and the security facts). This module only builds the Runtime adapter and adapts the
 * result back into the legacy registration shape.
 */
export function createExecCommandRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeProcessOperations(runtimeResolver);
  return toLegacyToolRegistration(createExecCommandTool(operations));
}

/**
 * The `exec_command` data description, for the legacy public export surface.
 *
 * A projection of the target Tool's own schema and Coding security metadata, not a second copy of it.
 */
export const execCommandDefinition = toolDefinitionFromCodingTool(
  createExecCommandTool(createRuntimeProcessOperations(DEFINITION_ONLY_RUNTIME_RESOLVER)),
);
