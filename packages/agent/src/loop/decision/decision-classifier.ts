import { isAIFinishReason } from "@caelush/ai";
import type {
  AIAssistantContent,
  AIAssistantMessage,
  AIModelTurnResult,
  AIToolCall,
} from "@caelush/ai";
import type {
  JsonObject as ProtocolJsonObject,
  JsonValue as ProtocolJsonValue,
} from "@caelush/protocol";

import type {
  AgentDecision,
  AgentModelTurn,
  AgentToolCallsDecision,
  AgentToolRequest,
} from "./decision.js";
import { AgentModelOutputError } from "./decision-error.js";
import type { AgentModelOutputMetadata } from "./decision-error.js";

/**
 * The frozen decision classifier.
 *
 * One settled model turn goes in; exactly one {@link AgentDecision} comes out. This is
 * the single place where "the model stopped" becomes "the agent acts", and every rule
 * here is a fail-closed rule.
 *
 * Finish reason semantics:
 *
 * ```text
 * STOP            text, optionally with completed tool calls
 * TOOL_CALLS      must carry at least one completed tool call
 * LENGTH          rejected: a truncated turn's arguments cannot be trusted
 * CONTENT_FILTER  rejected: the provider withheld content
 * OTHER           rejected: an unrecognised reason is not evidence of completion
 * ```
 *
 * Structural rules, checked before anything can become a decision:
 *
 * ```text
 * provider must match the model's provider
 * tool call ids must be unique within the turn
 * the assistant message must be non-empty
 * a TOOL_CALLS finish reason must produce at least one call
 * an empty or whitespace-only answer is not a candidate
 * ```
 */
export interface AgentDecisionClassifier {
  classify(result: AIModelTurnResult): AgentDecision;
}

/** Create the frozen decision classifier. */
export function createAgentDecisionClassifier(): AgentDecisionClassifier {
  return {
    classify(result: AIModelTurnResult): AgentDecision {
      return classifyAgentDecision(result);
    },
  };
}

/**
 * Classify one settled AI model turn into an agent decision.
 *
 * Exported as a function as well as through the frozen interface: the Core
 * compatibility layer classifies turns without owning a classifier instance, and a
 * classifier that could disagree with the function would be a second decision authority.
 */
export function classifyAgentDecision(result: AIModelTurnResult): AgentDecision {
  const metadata: AgentModelOutputMetadata = {
    callId: result.callId,
    providerId: result.providerId,
    model: result.model,
    finishReason: result.finishReason,
    toolCallCount: result.toolCalls.length,
  };

  // The finish reason must be one the AI core can name. A structurally foreign value
  // means the result did not come from the frozen AI contract.
  if (!isAIFinishReason(result.finishReason)) {
    throw new AgentModelOutputError("INVALID_TURN_RESULT", metadata);
  }
  // A turn that claims a provider different from its own model's provider has no single
  // authority behind it.
  if (result.providerId !== result.model.provider) {
    throw new AgentModelOutputError("MODEL_IDENTITY_MISMATCH", metadata);
  }
  if (result.finishReason === "LENGTH") {
    // Truncated output can carry syntactically valid but semantically incomplete tool
    // arguments. It must never reach a Tool, and it must never reach verification.
    throw new AgentModelOutputError("OUTPUT_TRUNCATED", metadata);
  }
  if (result.finishReason === "CONTENT_FILTER") {
    throw new AgentModelOutputError("CONTENT_FILTERED", metadata);
  }
  if (result.finishReason === "OTHER") {
    throw new AgentModelOutputError("UNKNOWN_FINISH_REASON", metadata);
  }

  assertUniqueToolCallIds(result.toolCalls, metadata);

  const assistantMessage = toAssistantMessage(result);
  if (assistantMessage.content.length === 0) {
    throw new AgentModelOutputError("EMPTY_RESPONSE", metadata);
  }

  const modelTurn: AgentModelTurn = {
    callId: result.callId,
    model: result.model,
    finishReason: result.finishReason,
    assistantMessage,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };

  if (result.toolCalls.length > 0) {
    return {
      type: "TOOL_CALLS_REQUESTED",
      modelTurn,
      toolRequests: result.toolCalls.map(toToolRequest),
    } satisfies AgentToolCallsDecision;
  }
  if (result.finishReason === "TOOL_CALLS") {
    throw new AgentModelOutputError("MISSING_TOOL_CALLS", metadata);
  }
  if (result.text.trim().length === 0) {
    throw new AgentModelOutputError("EMPTY_RESPONSE", metadata);
  }
  return { type: "FINAL_CANDIDATE", modelTurn, candidateText: result.text };
}

/**
 * Project the settled turn onto the durable-shaped assistant message.
 *
 * Only the two frozen AI assistant content parts exist, so this projection cannot
 * invent one. Tool-call order is the announcement order the assembler already
 * normalized, which keeps a replayed turn byte-identical.
 */
function toAssistantMessage(result: AIModelTurnResult): AIAssistantMessage {
  const content: AIAssistantContent[] = [];
  if (result.text.length > 0) {
    content.push({ type: "text", text: result.text });
  }
  for (const toolCall of result.toolCalls) {
    content.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
    });
  }
  return { role: "assistant", content };
}

function toToolRequest(toolCall: AIToolCall): AgentToolRequest {
  return {
    externalCallId: toolCall.id,
    toolName: toolCall.name,
    args: toProtocolJsonObject(toolCall.input),
  };
}

/**
 * Project an AI-local JSON object onto the Protocol JSON value model.
 *
 * The two packages own their own JSON types — `@caelush/ai` cannot depend on
 * `@caelush/protocol` — and they are structurally identical but nominally unrelated. A
 * completed tool call's arguments are durable, so they are copied rather than shared with
 * the adapter that produced them, field by field, never cast. The AI JSON contract admits
 * only JSON-safe values, so the fallback is unreachable for a value that came from an AI
 * turn result.
 */
function toProtocolJsonObject(value: { readonly [key: string]: unknown }): ProtocolJsonObject {
  const projected: Record<string, ProtocolJsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    projected[key] = toProtocolJsonValue(member);
  }
  return projected;
}

function toProtocolJsonValue(value: unknown): ProtocolJsonValue {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return (value as readonly unknown[]).map(toProtocolJsonValue);
  if (typeof value === "object") {
    return toProtocolJsonObject(value as { readonly [key: string]: unknown });
  }
  throw new TypeError("AI tool call input contained a value that is not JSON-safe.");
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
