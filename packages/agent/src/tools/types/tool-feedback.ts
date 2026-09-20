import type { JsonObject } from "@caelush/ai";

/**
 * How a failure should be treated once it is known.
 *
 * ```text
 * SAFE_FAILURE            the failure is understood and safe to describe to the model
 * UNCERTAIN_SIDE_EFFECT   the Tool may have partially or fully executed and nothing can prove
 *                         otherwise, so the batch must behave conservatively
 * ```
 *
 * The distinction is a first-class safety semantic, not a severity label. `SAFE_FAILURE` means "this
 * did not happen, and here is why"; `UNCERTAIN_SIDE_EFFECT` means "this may have happened, do not
 * automatically repeat it". Collapsing the second into the first is what produces duplicate patches,
 * duplicate commands and duplicate external requests after a restart.
 */
export type ToolFailureDisposition = "SAFE_FAILURE" | "UNCERTAIN_SIDE_EFFECT";

/**
 * A failure a Tool Layer component is willing to state to the model.
 *
 * ```text
 * code               a stable, non-localized machine code (for example TOOL_ARGUMENT_ERROR)
 * content            bounded, sanitized, specific, actionable text
 * details            JSON-safe structure for diagnostics that never carries raw host data
 * disposition        SAFE_FAILURE or UNCERTAIN_SIDE_EFFECT
 * blockToolFailures  may an identical retry of this exact call be refused pre-execution?
 * ```
 *
 * Every producer of this shape owns the same four obligations:
 *
 * ```text
 * safe         no absolute host paths, secrets, stack traces, provider details or raw arguments
 * sanitized    already projected through the redaction boundary of the producing layer
 * bounded      content and details respect the layering output policy
 * actionable   the model can tell what to change, not merely that something failed
 * ```
 *
 * ## `blockToolFailures` is about repetition, not severity
 *
 * A Tool that failed for a reason its own arguments caused should not be called again with the same
 * arguments: repeating it produces the same failure, and a model that retries forever burns a Run. A
 * refusal over a *transient* condition must not set this — the same call may legitimately succeed a
 * moment later.
 *
 * The flag is a **request**, not a mechanism: the layer that decides whether a retry is refused is the
 * one that owns the refusal policy, and it reads this as one input among several.
 *
 * Producing safe feedback is a *request* to describe a failure, not a permission to describe
 * anything: the consumer still enforces structure, size and sanitization, so naming the right error
 * class never smuggles raw data into model history.
 *
 * A preparation failure is by default `SAFE_FAILURE`. Nothing executed, so nothing can be uncertain,
 * and manufacturing an uncertain-side-effect conclusion before a handler ever ran would poison the
 * batch barrier.
 */
export interface ToolFailureFeedback {
  readonly code: string;
  readonly content: string;
  readonly details: JsonObject;
  readonly disposition: ToolFailureDisposition;
  /**
   * Whether an identical retry may be refused before execution.
   *
   * Absent means "no opinion", which a refusal policy must read as "do not block": blocking on an
   * unstated assumption would refuse a call nobody concluded was unrepeatable.
   */
  readonly blockToolFailures?: boolean | undefined;
}
