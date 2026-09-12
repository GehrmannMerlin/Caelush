import { isAIFinishReason } from "@caelush/ai";
import type { AIModelTurnResult, AIToolCall } from "@caelush/ai";
import { AgentModelOutputError, type AgentModelOutputMetadata } from "./agent-errors.js";
import {
  toProtocolAssistantMessage,
  toProtocolCallId,
  toProtocolToolInput,
} from "./ai-invocation-projection.js";
import type { AgentDecision, AgentModelTurn, AgentToolRequest } from "./agent-decision.js";

/**
 * Classify one settled AI model turn into an agent decision.
 *
 * This is the frozen decision boundary of the agent kernel: a turn either requests
 * tools or offers a final candidate. Everything else is invalid model output and
 * fails closed.
 *
 * Finish reason semantics:
 *
 * ```text
 * STOP            text (plus optional completed tool calls) or a final candidate
 * TOOL_CALLS      must carry at least one completed tool call
 * LENGTH          rejected: the arguments of a truncated turn cannot be trusted
 * CONTENT_FILTER  rejected: the provider withheld content
 * OTHER           rejected: an unrecognised reason is not evidence of completion
 * ```
 *
 * `OTHER` in particular must never become `FINAL_CANDIDATE`. The AI core preserves
 * an unknown provider reason rather than calling it `STOP`, and this boundary is
 * where that honesty has to be enforced.
 */
export function classifyAgentDecision(result: AIModelTurnResult): AgentDecision {
  const metadata: AgentModelOutputMetadata = {
    callId: toProtocolCallId(result.callId),
    providerId: result.providerId,
    model: result.model,
    finishReason: result.finishReason,
    toolCallCount: result.toolCalls.length,
  };

  if (!isAIFinishReason(result.finishReason)) {
    throw new AgentModelOutputError("INVALID_TURN_RESULT", metadata);
  }
  if (result.providerId !== result.model.provider) {
    throw new AgentModelOutputError("MODEL_IDENTITY_MISMATCH", metadata);
  }
  if (result.finishReason === "LENGTH") {
    throw new AgentModelOutputError("OUTPUT_TRUNCATED", metadata);
  }
  if (result.finishReason === "CONTENT_FILTER") {
    throw new AgentModelOutputError("CONTENT_FILTERED", metadata);
  }
  if (result.finishReason === "OTHER") {
    throw new AgentModelOutputError("UNKNOWN_FINISH_REASON", metadata);
  }

  assertUniqueToolCallIds(result.toolCalls, metadata);

  let assistantMessage;
  try {
    assistantMessage = toProtocolAssistantMessage(result);
  } catch {
    throw new AgentModelOutputError("INVALID_TURN_RESULT", metadata);
  }
  if (assistantMessage.content.length === 0) {
    throw new AgentModelOutputError("EMPTY_RESPONSE", metadata);
  }

  const modelTurn: AgentModelTurn = {
    callId: toProtocolCallId(result.callId),
    model: result.model,
    finishReason: result.finishReason,
    assistantMessage,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };

  if (result.toolCalls.length > 0) {
    const toolRequests: AgentToolRequest[] = result.toolCalls.map((toolCall) => ({
      externalCallId: toolCall.id,
      toolName: toolCall.name,
      args: toProtocolToolInput(toolCall),
    }));
    return { type: "TOOL_CALLS_REQUESTED", modelTurn, toolRequests };
  }
  if (result.finishReason === "TOOL_CALLS") {
    throw new AgentModelOutputError("MISSING_TOOL_CALLS", metadata);
  }
  if (result.text.trim().length === 0) {
    throw new AgentModelOutputError("EMPTY_RESPONSE", metadata);
  }
  return { type: "FINAL_CANDIDATE", modelTurn, candidateText: result.text };
}

function assertUniqueToolCallIds(
  toolCalls: readonly AIToolCall[],
  metadata: AgentModelOutputMetadata,
): void {
  const seen = new Set<string>();
  for (const toolCall of toolCalls) {
    if (seen.has(toolCall.id)) {
      throw new AgentModelOutputError("DUPLICATE_TOOL_CALL_ID", metadata);
    }
    seen.add(toolCall.id);
  }
}
