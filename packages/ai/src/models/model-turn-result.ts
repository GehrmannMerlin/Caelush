import type { AIFinishReason, AIToolCall } from "../tools/tool-call.js";
import type { AIInvocationResolution } from "../request/resolved-model-request.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelRef } from "./model-ref.js";
import type { ModelUsage } from "./model-usage.js";
import type { ProviderId } from "../ids/provider-id.js";

/**
 * The settled outcome of one model turn.
 *
 * This is durable-shaped data, so it contains only what a caller may keep: the
 * identity of the call, the assistant text, the completed tool calls, the finish
 * reason and the usage snapshot. Reasoning summaries and partial tool calls are
 * deliberately absent — a summary is not durable assistant content, and a
 * truncated tool call must never look executable.
 */
export interface AIModelTurnResult {
  readonly callId: LLMCallId;
  readonly providerId: ProviderId;
  readonly model: ModelRef;
  readonly text: string;
  readonly toolCalls: readonly AIToolCall[];
  readonly finishReason: AIFinishReason;
  readonly usage?: ModelUsage;
  readonly resolution: AIInvocationResolution;
}
