import type { ModelUsage } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

/**
 * The canonical agent decision-rejection types live in `@caelush/agent` from Phase 3A.
 *
 * They are re-exported rather than redeclared: a second `AgentModelOutputError` class in
 * Core would make `instanceof` checks disagree about the same failure, and the classifier's
 * rejection reason would be free to drift from the durable mapping that reads it.
 */
export { AgentModelOutputError } from "@caelush/agent";
export type { AgentModelOutputErrorReason, AgentModelOutputMetadata } from "@caelush/agent";

export type AgentToolResultBatchErrorReason =
  | "INVALID_RESULT"
  | "MISSING_RESULT"
  | "UNEXPECTED_RESULT"
  | "DUPLICATE_RESULT"
  | "TOOL_NAME_MISMATCH"
  | "DUPLICATE_REQUEST_ID";

export interface AgentToolResultBatchErrorMetadata {
  readonly toolCallId?: string;
  readonly toolName?: ToolName;
  readonly requestCount?: number;
  readonly resultCount?: number;
}

export class AgentToolResultBatchError extends Error {
  readonly reason: AgentToolResultBatchErrorReason;
  readonly metadata: AgentToolResultBatchErrorMetadata;

  constructor(
    reason: AgentToolResultBatchErrorReason,
    metadata: AgentToolResultBatchErrorMetadata = {},
  ) {
    super(`Agent tool result batch rejected: ${reason}.`);
    this.name = "AgentToolResultBatchError";
    this.reason = reason;
    this.metadata = metadata;
  }
}

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

export class AgentLoopInputError extends Error {
  constructor(reason: string) {
    super(`Agent loop input rejected: ${reason}.`);
    this.name = "AgentLoopInputError";
  }
}

export type AgentBudgetBlock =
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOOL_CALLS" | "TOKENS" | "COST";
      readonly accounted: number;
      readonly limit: number;
      readonly limitMicros?: number;
      readonly accountedMicros?: number;
    }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "PRICING" | "TOKEN_ESTIMATE" };

export class AgentBudgetAdmissionError extends Error {
  readonly block: AgentBudgetBlock;

  constructor(block: AgentBudgetBlock) {
    super(`Agent budget admission rejected: ${block.kind}.`);
    this.name = "AgentBudgetAdmissionError";
    this.block = block;
  }
}

export type AgentStepUsage = Pick<ModelUsage, "inputTokens" | "outputTokens">;
