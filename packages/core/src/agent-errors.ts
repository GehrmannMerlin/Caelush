import type { ModelUsage } from "@caelush/ai";
import type { AgentBudgetBlock as CanonicalAgentBudgetBlock } from "@caelush/agent";

/**
 * The canonical agent decision-rejection types live in `@caelush/agent` from Phase 3A.
 *
 * They are re-exported rather than redeclared: a second `AgentModelOutputError` class in
 * Core would make `instanceof` checks disagree about the same failure, and the classifier's
 * rejection reason would be free to drift from the durable mapping that reads it.
 */
export { AgentModelOutputError } from "@caelush/agent";
export type { AgentModelOutputErrorReason, AgentModelOutputMetadata } from "@caelush/agent";

/**
 * The canonical Tool result batch error lives in `@caelush/agent` from Phase 4D.
 *
 * ```text
 * canonical declaration   @caelush/agent  (tools/batch/batch-errors.ts)
 * this module             a re-export of the same class identity
 * ```
 *
 * As with `AgentModelOutputError` above, a second declaration would make `instanceof` disagree about
 * the same failure: the canonical `ToolResultBatchNormalizer` throws the Agent class, and the Run
 * Layer catches it by class when it decides whether a batch failure is a model error or a runtime
 * error. Re-exporting keeps one declaration and one identity, so an existing Core caller that imports
 * `AgentToolResultBatchError` from `@caelush/core` gets exactly the class the normalizer throws.
 */
export { AgentToolResultBatchError } from "@caelush/agent";
export type {
  AgentToolResultBatchErrorMetadata,
  AgentToolResultBatchErrorReason,
} from "@caelush/agent";

export class ToolBatchResultConversionError extends Error {
  constructor(reason = "Tool batch result does not match the source Tool Calls.") {
    super(reason);
    this.name = "ToolBatchResultConversionError";
  }
}

/**
 * The kernel state rejection, in the Run Layer's own vocabulary.
 *
 * Phase 3C moved the canonical durable Step lifecycle into `@caelush/agent`, so the error the
 * kernel throws is the kernel's. This is an alias rather than a second class: `instanceof` has to
 * agree with the throw, and two classes meaning the same thing would quietly stop agreeing.
 */
export { AgentStepStateError as AgentKernelStateError } from "@caelush/agent";

/**
 * The budget refusal vocabulary, in the canonical Agent declaration.
 *
 * ```text
 * Phase 10D froze the shape; Phase 4C moved the declaration
 * ```
 *
 * `AgentBudgetBlock` is the answer the Agent Layer's own admission ports give — the model admission
 * port, the Tool turn contract and the canonical `ToolBudgetAdmissionPort` all speak it — so the
 * layer that declares those ports is the layer that declares it. Core re-exports the canonical
 * declaration rather than restating it:
 *
 * ```text
 * one declaration   @caelush/agent  loop/ports/model-request-admission.ts
 * one re-export     @caelush/core   this file
 * ```
 *
 * Two structural twins would be a second accounting authority: `EXCEEDED` and `UNAVAILABLE` would be
 * assignable in one direction only, and a consumer that switched exhaustively over one could silently
 * fall through the other.
 */
export type { AgentBudgetBlock } from "@caelush/agent";
export class AgentBudgetAdmissionError extends Error {
  readonly block: CanonicalAgentBudgetBlock;

  constructor(block: CanonicalAgentBudgetBlock) {
    super(`Agent budget admission rejected: ${block.kind}.`);
    this.name = "AgentBudgetAdmissionError";
    this.block = block;
  }
}

export type AgentStepUsage = Pick<ModelUsage, "inputTokens" | "outputTokens">;
