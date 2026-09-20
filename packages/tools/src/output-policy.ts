import {
  boundToolResultContent,
  TOOL_RESULT_TRUNCATION_MARKER,
  ToolResultLimitError,
  validateToolResultLimits,
} from "@caelush/agent";
import { ToolRegistrationError } from "./errors.js";

/**
 * The legacy Tool output policy.
 *
 * ```text
 * canonical implementation   @caelush/agent result policy
 * this module                a delegating compatibility facade
 * ```
 *
 * The two fields are facets of the canonical `ToolResultLimits`:
 *
 * ```text
 * maxModelContentBytes  ->  maxDurableContentBytes   (value unchanged in this migration wave)
 * maxDetailsBytes       ->  maxDetailsBytes
 * ```
 *
 * The rename is not cosmetic. The number bounds what this layer will *commit durably*; what a model
 * is ultimately shown is a smaller, separately owned budget decided by the Context layer's
 * observation policy. Keeping the old name in new code would make two different budgets look like
 * one.
 *
 * There is no truncation algorithm here. `boundToolModelContent` delegates to the canonical
 * implementation, so a UTF-8 boundary decision can only ever be made in one place.
 */
export interface ToolOutputPolicy {
  readonly maxModelContentBytes: number;
  readonly maxDetailsBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = Object.freeze({
  maxModelContentBytes: 64 * 1024,
  maxDetailsBytes: 256 * 1024,
});

/** The canonical limits a legacy policy expresses. */
export function toCanonicalToolResultLimits(policy: ToolOutputPolicy): {
  readonly maxDurableContentBytes: number;
  readonly maxDetailsBytes: number;
} {
  validateToolOutputPolicy(policy);
  return {
    maxDurableContentBytes: policy.maxModelContentBytes,
    maxDetailsBytes: policy.maxDetailsBytes,
  };
}

export function validateToolOutputPolicy(policy: ToolOutputPolicy): ToolOutputPolicy {
  try {
    validateToolResultLimits({
      maxDurableContentBytes: policy.maxModelContentBytes,
      maxDetailsBytes: policy.maxDetailsBytes,
    });
  } catch (error) {
    if (error instanceof ToolResultLimitError) {
      throw new ToolRegistrationError(
        "Tool output policy maxModelContentBytes must be a positive integer.",
        { reason: "INVALID_OUTPUT_POLICY" },
      );
    }
    throw error;
  }
  return policy;
}

/** The canonical UTF-8 byte bound, under the legacy name. */
export function boundToolModelContent(
  content: string,
  policy: ToolOutputPolicy = DEFAULT_TOOL_OUTPUT_POLICY,
): string {
  return boundToolResultContent(content, toCanonicalToolResultLimits(policy));
}

/** The canonical truncation marker, re-exported so one declaration exists. */
export const TOOL_OUTPUT_TRUNCATION_MARKER = TOOL_RESULT_TRUNCATION_MARKER;
