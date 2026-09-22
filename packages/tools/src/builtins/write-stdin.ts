import { createRuntimeProcessOperations, createWriteStdinTool } from "@caelush/coding-agent";
import type { RuntimeResolver } from "@caelush/runtime";

import {
  DEFINITION_ONLY_RUNTIME_RESOLVER,
  toLegacyToolRegistration,
  toolDefinitionFromCodingTool,
} from "../coding-tool-adapter.js";
import type { ToolRegistration } from "../registration.js";

/**
 * `write_stdin` — a thin compatibility facade over the Coding product layer.
 *
 * The empty-poll semantics, the `PROCESS_SESSION_NOT_FOUND` and `INVALID_STDIN` codes, the
 * `PROCESS_STOPPED` effect projection and the transient-output sink all belong to the target factory.
 * This module wires the Runtime process adapter to it and projects the result.
 */
export function createWriteStdinRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const operations = createRuntimeProcessOperations(runtimeResolver);
  return toLegacyToolRegistration(createWriteStdinTool(operations));
}

/**
 * The `write_stdin` data description, for the legacy public export surface.
 *
 * A projection of the target Tool's own schema and Coding security metadata.
 */
export const writeStdinDefinition = toolDefinitionFromCodingTool(
  createWriteStdinTool(createRuntimeProcessOperations(DEFINITION_ONLY_RUNTIME_RESOLVER)),
);
