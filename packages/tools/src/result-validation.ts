import {
  boundToolResultContent,
  validateToolResult,
  ToolResultValidationError,
} from "@caelush/agent";
import type { ToolResultLimits } from "@caelush/agent";
import { ToolRegistrationError } from "./errors.js";
import type { ResolvedTool } from "./registry.js";

/**
 * The legacy Tool result contract.
 *
 * ```text
 * canonical implementation   @caelush/agent result layer
 * this module                a delegating compatibility facade
 * ```
 *
 * It owns no algorithm. Shape reading, the details byte budget, the result-details schema check, the
 * defensive copy and the durable content bound all happen in the canonical implementation; what this
 * file provides is the legacy *names* an existing caller still imports, plus the legacy option shape,
 * which names the durable content budget `maxModelContentBytes`.
 */

/** The legacy result-details schema budget name. The canonical name is `maxDetailsBytes`. */
export interface ToolExecutionResultLimitsFacet {
  readonly maxDetailsBytes: number;
}

export interface ValidatedToolExecutionResult {
  readonly content: string;
  readonly details: import("@caelush/protocol").JsonObject;
  readonly isError: boolean;
}

/**
 * The legacy validation failure, re-based on the canonical one.
 *
 * Extending the canonical class is deliberate: a caller that catches the legacy name and a canonical
 * component that catches the canonical name both succeed on the same thrown value, so the two
 * identities cannot split. `kind` keeps its legacy meaning.
 */
export class ToolExecutionResultValidationError extends ToolResultValidationError {}

/**
 * Validate and bound a Tool execution result.
 *
 * ```text
 * value          the raw producer value, of unknown shape
 * resolvedTool   the legacy resolved Tool; its compiled validator is the one that validates
 * policy         the legacy output policy, whose content budget maps to the durable bound
 * ```
 *
 * The legacy facade passes the *legacy* resolved Tool, so the validator used here is the one bound at
 * registration. That is the transitional state by design: 4B moved the algorithm, not the binding.
 * Both the legacy entry point and the canonical result pipeline therefore run one validator through
 * one implementation.
 */
export function validateToolExecutionResult(
  value: unknown,
  resolvedTool: ResolvedTool,
  policy?: { readonly maxModelContentBytes: number; readonly maxDetailsBytes: number },
): ValidatedToolExecutionResult {
  return validateToolResult({
    value,
    resolved:
      resolvedTool.agentTool === undefined
        ? legacyResolved(resolvedTool)
        : {
            tool: resolvedTool.agentTool,
            inputValidator: resolvedTool.inputValidator,
            resultValidator: resolvedTool.outputValidator,
          },
    limits: toDurableLimits(policy),
  }) as ValidatedToolExecutionResult;
}

/**
 * The canonical limits a legacy policy expresses.
 *
 * `maxModelContentBytes` becomes `maxDurableContentBytes`: the *value* is unchanged in the first
 * migration wave, and only the owner's vocabulary moves, because the durable bound and a future
 * model-context observation budget are different numbers owned by different layers.
 */
export function toDurableToolResultLimits(policy?: {
  readonly maxModelContentBytes: number;
  readonly maxDetailsBytes: number;
}): ToolResultLimits {
  return toDurableLimits(policy);
}

function toDurableLimits(policy?: {
  readonly maxModelContentBytes: number;
  readonly maxDetailsBytes: number;
}): ToolResultLimits {
  if (policy === undefined) {
    return {
      maxDurableContentBytes: 64 * 1024,
      maxDetailsBytes: 256 * 1024,
    };
  }
  validateLegacyLimits(policy);
  return {
    maxDurableContentBytes: policy.maxModelContentBytes,
    maxDetailsBytes: policy.maxDetailsBytes,
  };
}

function validateLegacyLimits(policy: {
  readonly maxModelContentBytes: number;
  readonly maxDetailsBytes: number;
}): void {
  if (
    !Number.isSafeInteger(policy.maxModelContentBytes) ||
    policy.maxModelContentBytes <= 0 ||
    !Number.isSafeInteger(policy.maxDetailsBytes) ||
    policy.maxDetailsBytes <= 0
  ) {
    throw new ToolRegistrationError(
      "Tool output policy maxModelContentBytes must be a positive integer.",
      { reason: "INVALID_OUTPUT_POLICY" },
    );
  }
}

/** The canonical content bound, re-exported for a legacy caller that only wants text bounding. */
export { boundToolResultContent };

/**
 * A canonical resolved entry standing in for a legacy resolved Tool that carries no AgentTool.
 *
 * The canonical declaration requires an `AgentTool`. A legacy fixture that never registered one still
 * has a definition and a handler, so an equivalent AgentTool is described — the same projection the
 * registry builder makes — and the compiled result validator is reused unchanged. No schema is
 * compiled here.
 */
function legacyResolved(resolvedTool: ResolvedTool): {
  readonly tool: import("@caelush/agent").AgentTool;
  readonly inputValidator: import("@caelush/agent").CompiledToolSchema;
  readonly resultValidator: import("@caelush/agent").CompiledToolSchema;
} {
  return {
    tool: {
      name: resolvedTool.definition.name,
      description: resolvedTool.definition.description,
      inputSchema: resolvedTool.definition.inputSchema,
      label: resolvedTool.definition.name,
      resultDetailsSchema: resolvedTool.definition.outputSchema,
      executionMode: "SEQUENTIAL",
      execute: async () => ({ content: "", details: {}, isError: false }),
    },
    inputValidator: resolvedTool.inputValidator,
    resultValidator: resolvedTool.outputValidator,
  };
}
