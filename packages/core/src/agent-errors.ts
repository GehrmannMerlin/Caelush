import type { AIFinishReason, ModelUsage } from "@caelush/ai";
import type { LLMCallId, ModelRef, ToolName } from "@caelush/protocol";

export type AgentModelOutputErrorReason =
  | "INVALID_TURN_RESULT"
  | "MODEL_IDENTITY_MISMATCH"
  | "OUTPUT_TRUNCATED"
  | "CONTENT_FILTERED"
  | "EMPTY_RESPONSE"
  | "MISSING_TOOL_CALLS"
  | "DUPLICATE_TOOL_CALL_ID"
  /**
   * The provider reported a finish reason the AI core could not interpret, so the
   * turn became `AIFinishReason.OTHER`.
   *
   * `OTHER` is never evidence that the model finished its answer: an unrecognised
   * provider reason could mean anything, including a truncated or aborted stream. It
   * is rejected rather than treated as a normal stop.
   */
  | "UNKNOWN_FINISH_REASON";

export interface AgentModelOutputMetadata {
  readonly callId?: LLMCallId;
  readonly providerId?: string;
  readonly model?: ModelRef;
  readonly finishReason?: AIFinishReason;
  readonly toolCallCount?: number;
}

export class AgentModelOutputError extends Error {
  readonly reason: AgentModelOutputErrorReason;
  readonly metadata: AgentModelOutputMetadata;

  constructor(reason: AgentModelOutputErrorReason, metadata: AgentModelOutputMetadata = {}) {
    super(`Agent model output rejected: ${reason}.`);
    this.name = "AgentModelOutputError";
    this.reason = reason;
    this.metadata = metadata;
  }
}

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

export class AgentKernelStateError extends Error {
  constructor(reason: string) {
    super(`Agent kernel state rejected: ${reason}.`);
    this.name = "AgentKernelStateError";
  }
}

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
