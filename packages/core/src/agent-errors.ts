import type { FinishReason, LLMUsage } from "@caelush/llm/turn";
import type { LLMCallId, ModelRef, ToolName } from "@caelush/protocol";

export type AgentModelOutputErrorReason =
  | "INVALID_TURN_RESULT"
  | "MODEL_IDENTITY_MISMATCH"
  | "OUTPUT_TRUNCATED"
  | "CONTENT_FILTERED"
  | "EMPTY_RESPONSE"
  | "MISSING_TOOL_CALLS"
  | "DUPLICATE_TOOL_CALL_ID";

export interface AgentModelOutputMetadata {
  readonly callId?: LLMCallId;
  readonly providerId?: string;
  readonly model?: ModelRef;
  readonly finishReason?: FinishReason;
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

export class AgentKernelStateError extends Error {
  constructor(reason: string) {
    super(`Agent kernel state rejected: ${reason}.`);
    this.name = "AgentKernelStateError";
  }
}

export type AgentStepUsage = Pick<LLMUsage, "inputTokens" | "outputTokens">;
