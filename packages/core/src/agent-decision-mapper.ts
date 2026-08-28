import { LLMAssistantMessageSchema, type LLMAssistantContent } from "@caelush/llm/messages";
import { LLMTurnResultSchema, type LLMTurnResult } from "@caelush/llm/turn";
import { AgentModelOutputError, type AgentModelOutputMetadata } from "./agent-errors.js";
import type { AgentDecision, AgentModelTurn, AgentToolRequest } from "./agent-decision.js";

export function classifyAgentDecision(result: LLMTurnResult): AgentDecision {
  const parsedResult = LLMTurnResultSchema.safeParse(result);
  if (!parsedResult.success) {
    throw new AgentModelOutputError("INVALID_TURN_RESULT");
  }

  const normalized = parsedResult.data;
  const metadata: AgentModelOutputMetadata = {
    callId: normalized.callId,
    providerId: normalized.providerId,
    model: normalized.model,
    finishReason: normalized.finishReason,
    toolCallCount: normalized.toolCalls.length,
  };
  if (normalized.providerId !== normalized.model.provider) {
    throw new AgentModelOutputError("MODEL_IDENTITY_MISMATCH", metadata);
  }
  if (normalized.finishReason === "LENGTH") {
    throw new AgentModelOutputError("OUTPUT_TRUNCATED", metadata);
  }
  if (normalized.finishReason === "CONTENT_FILTER") {
    throw new AgentModelOutputError("CONTENT_FILTERED", metadata);
  }

  const seenToolCallIds = new Set<string>();
  for (const toolCall of normalized.toolCalls) {
    if (seenToolCallIds.has(toolCall.id)) {
      throw new AgentModelOutputError("DUPLICATE_TOOL_CALL_ID", metadata);
    }
    seenToolCallIds.add(toolCall.id);
  }

  const assistantContent: LLMAssistantContent[] = [];
  if (normalized.text.length > 0) {
    assistantContent.push({ type: "text", text: normalized.text });
  }
  assistantContent.push(
    ...normalized.toolCalls.map((toolCall) => ({
      type: "tool-call" as const,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
    })),
  );
  const assistantMessage = LLMAssistantMessageSchema.safeParse({
    role: "assistant",
    content: assistantContent,
  });
  if (!assistantMessage.success) {
    throw new AgentModelOutputError("INVALID_TURN_RESULT", metadata);
  }

  const modelTurn: AgentModelTurn = {
    callId: normalized.callId,
    model: normalized.model,
    finishReason: normalized.finishReason,
    assistantMessage: assistantMessage.data,
    ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
  };

  if (normalized.toolCalls.length > 0) {
    const toolRequests: AgentToolRequest[] = normalized.toolCalls.map((toolCall) => ({
      externalCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.input,
    }));
    return { type: "TOOL_CALLS_REQUESTED", modelTurn, toolRequests };
  }
  if (normalized.finishReason === "TOOL_CALLS") {
    throw new AgentModelOutputError("MISSING_TOOL_CALLS", metadata);
  }
  if (normalized.text.trim().length === 0) {
    throw new AgentModelOutputError("EMPTY_RESPONSE", metadata);
  }
  return { type: "FINAL_CANDIDATE", modelTurn, candidateText: normalized.text };
}
