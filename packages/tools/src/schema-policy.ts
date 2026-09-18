import type { ToolDefinition } from "@caelush/protocol";
import {
  AgentToolSchemaCompileError,
  AgentToolRegistrationError,
  AgentToolRegistryStateError,
  validateToolSchemaSemantics,
  type CompiledToolSchema,
  type ToolRegistryOptions as CanonicalToolRegistryOptions,
  type ToolSchemaRuntime,
} from "@caelush/agent";

import { toCanonicalToolRegistryOptions, type ToolRegistryOptions } from "./options.js";
import { throwLegacyRegistrationError } from "./tool-system-bridge.js";

export type {
  CompiledToolSchema,
  ToolSchemaIssue,
  ToolSchemaValidationResult,
} from "@caelush/agent";
export { ToolSchemaRuntime, containsForbiddenSchemaFeature } from "@caelush/agent";

export interface ValidatedToolSchemas {
  readonly input: CompiledToolSchema;
  readonly output: CompiledToolSchema;
}

const CANONICAL_REGISTRATION_ERRORS = [
  AgentToolRegistrationError,
  AgentToolSchemaCompileError,
  AgentToolRegistryStateError,
] as const;

/** True when a caller supplied the legacy result-schema budget name instead of the canonical one. */
function hasLegacyResultBudget(
  options: ToolRegistryOptions | CanonicalToolRegistryOptions,
): options is ToolRegistryOptions {
  return !("maxResultSchemaBytes" in options);
}

/**
 * The legacy semantic validation entry point, delegating to the canonical schema policy.
 *
 * ```text
 * legacy ToolDefinition     ──▶  { name, description, inputSchema } + outputSchema
 *                                ──▶ validateToolSchemaSemantics(...)
 * legacy ValidatedToolSchemas  ◀──  { input, result }
 * ```
 *
 * The two vocabularies differ in one word: the canonical contract calls the result-details schema
 * budget `maxResultSchemaBytes`, the legacy option set calls it `maxOutputSchemaBytes`. Both bounds,
 * both rules and the single AJV policy live in the canonical implementation; this function translates
 * the outside, never the inside.
 */
export function validateToolDefinitionSemantics(
  value: unknown,
  options: ToolRegistryOptions | CanonicalToolRegistryOptions,
  runtime: ToolSchemaRuntime,
): ValidatedToolSchemas {
  const canonicalOptions = hasLegacyResultBudget(options)
    ? toCanonicalToolRegistryOptions(options)
    : options;
  const definition = value as ToolDefinition;

  try {
    const validated = validateToolSchemaSemantics(
      {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      definition.outputSchema,
      canonicalOptions,
      runtime,
    );
    return { input: validated.input, output: validated.result };
  } catch (error) {
    if (CANONICAL_REGISTRATION_ERRORS.some((kind) => error instanceof kind)) {
      throwLegacyRegistrationError(error);
    }
    throw error;
  }
}
