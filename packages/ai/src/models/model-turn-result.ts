import type { AIFinishReason, AIToolCall } from "../tools/tool-call.js";
import type { AIReceivedToolRequest } from "../tools/received-tool-request.js";
import type { AIInvocationResolution } from "../request/resolved-model-request.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelRef } from "./model-ref.js";
import type { ModelUsage } from "./model-usage.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { AIModelTurnAssistantItem } from "../messages/assistant-item.js";

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
  /**
   * Every request the turn produced, in source order, executable and rejected alike.
   *
   * This is the authority for "one result per request". `toolCalls` is its executable projection;
   * a rejected request exists only here and in the assistant items, carrying identity and a typed
   * reason but no argument object.
   */
  readonly toolRequests: readonly AIReceivedToolRequest[];
  /** The executable projection of {@link toolRequests}, in the same order. */
  readonly toolCalls: readonly AIToolCall[];
  /** Ordered, phase-aware assistant items when produced by the canonical stream assembler. */
  readonly assistantItems?: readonly AIModelTurnAssistantItem[];
  readonly finishReason: AIFinishReason;
  readonly usage?: ModelUsage;
  readonly resolution: AIInvocationResolution;
}
