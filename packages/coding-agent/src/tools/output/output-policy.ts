import {
  boundToolResultContent,
  TOOL_RESULT_TRUNCATION_MARKER,
  type ToolResultLimits,
} from "@caelush/agent";

/**
 * The Coding builtin output policy.
 *
 * ```text
 * maxModelContentBytes  →  the canonical maximal durable content bound
 * maxDetailsBytes       →  the canonical maximal details bound
 * ```
 *
 * ## Two budgets that must not be confused
 *
 * The number here bounds what this layer will **commit durably**. What a model is ultimately shown is a
 * *smaller, separately owned* budget decided by the Context layer's observation policy and applied by
 * the model feedback projector. The legacy name `maxModelContentBytes` is kept because Tool code and
 * tests refer to it, but the canonical field it maps onto is `maxDurableContentBytes`, and the rename is
 * exactly the distinction that matters.
 *
 * ## No truncation algorithm lives here
 *
 * `boundToolModelContent` delegates to the canonical `boundToolResultContent`, so a UTF-8 boundary
 * decision can only ever be made in one place. A second bounder would be a second answer to "where does
 * this string get cut", and two answers eventually disagree.
 *
 * ## Why this is Coding-owned
 *
 * The *values* — a large exec output bound, a read limit, a directory limit — are Coding product
 * policy. The general `ToolResultLimits` contract stays in `@caelush/agent`; this module supplies the
 * Coding numbers and the delegation.
 */
export interface CodingToolOutputPolicy {
  readonly maxModelContentBytes: number;
  readonly maxDetailsBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: CodingToolOutputPolicy = Object.freeze({
  maxModelContentBytes: 64 * 1024,
  maxDetailsBytes: 256 * 1024,
});

/** The canonical limits a Coding policy expresses. */
export function toCanonicalToolResultLimits(policy: CodingToolOutputPolicy): ToolResultLimits {
  return {
    maxDurableContentBytes: policy.maxModelContentBytes,
    maxDetailsBytes: policy.maxDetailsBytes,
  };
}

/** The canonical UTF-8 byte bound, applied to Coding content. */
export function boundToolModelContent(
  content: string,
  policy: CodingToolOutputPolicy = DEFAULT_TOOL_OUTPUT_POLICY,
): string {
  return boundToolResultContent(content, toCanonicalToolResultLimits(policy));
}

/** The canonical truncation marker, re-exported so one declaration exists. */
export const TOOL_OUTPUT_TRUNCATION_MARKER = TOOL_RESULT_TRUNCATION_MARKER;
