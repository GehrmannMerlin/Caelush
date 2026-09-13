import { isAIFinishReason } from "@caelush/ai";
import type { AIModelTurnResult, AIToolCall } from "@caelush/ai";

import type { AgentDecision, AgentModelTurn, AgentToolCallsDecision } from "./decision.js";
import { toAgentModelTurn, toAgentToolRequest, toAssistantMessage } from "./decision.js";
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

  // The finish reason was validated above, so the shared projection is total here.
  const modelTurn = toAgentModelTurn(result) as AgentModelTurn;

  if (result.toolCalls.length > 0) {
    return {
      type: "TOOL_CALLS_REQUESTED",
      modelTurn,
      toolRequests: result.toolCalls.map(toAgentToolRequest),
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
