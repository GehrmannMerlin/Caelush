import { isAIFinishReason } from "@caelush/ai";
import type {
  AIAssistantContent,
  AIAssistantMessage,
  AIFinishReason,
  AIModelTurnResult,
  AIToolCall,
  ModelUsage,
} from "@caelush/ai";
import type { JsonObject, ToolName } from "@caelush/protocol";

/**
 * The frozen agent decision contract.
 *
 * This is where the general agent kernel states what the model decided, and it is
 * deliberately written entirely in `@caelush/ai` and `@caelush/protocol` types:
 *
 * ```text
 * assistant message   AIAssistantMessage      not LLMAssistantMessage
 * model identity      ModelDescriptor["ref"]  not the Protocol wire ModelRef
 * call identity       plain branded string    not Protocol LLMCallId (see below)
 * tool arguments      Protocol JsonObject     durable once a call is completed
 * ```
 *
 * The one identity that stays a plain string is `AgentModelTurn.callId`. The AI core
 * owns its own branded `LLMCallId` because it may not depend on `@caelush/protocol`,
 * and the two are the same `llm_<uuidv7>` value rather than two encodings of it. Keeping
 * the general decision free of either brand means the durable projection that re-brands
 * the identity lives in exactly one place: the Core compatibility boundary.
 */

/** One settled model turn, in the AI contract. */
export interface AgentModelTurn {
  /** The gateway-owned call identity, as an opaque `llm_<uuidv7>` string. */
  readonly callId: string;
  /** The resolved model authority for the turn. `provider + model` is the identity. */
  readonly model: import("@caelush/ai").ModelDescriptor["ref"];
  /** Why the model stopped, in the frozen AI finish-reason vocabulary. */
  readonly finishReason: AIFinishReason;
  /**
   * The durable-shaped assistant message.
   *
   * Reasoning summaries are absent by construction: a summary a provider produced for
   * display is never durable assistant content.
   */
  readonly assistantMessage: AIAssistantMessage;
  /**
   * The settled usage snapshot, when the provider reported one.
   *
   * `| undefined` is explicit because the durable continuation schema distinguishes
   * "absent" from "present but undefined" under `exactOptionalPropertyTypes`, and a turn
   * without usage must decode back into this shape unchanged.
   */
  readonly usage?: ModelUsage | undefined;
}

/** One tool invocation the model requested. */
export interface AgentToolRequest {
  /** The provider-issued tool call identity, unique within one turn. */
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

/** The model asked for tools, and the turn stops at the Tool boundary. */
export interface AgentToolCallsDecision {
  readonly type: "TOOL_CALLS_REQUESTED";
  readonly modelTurn: AgentModelTurn;
  readonly toolRequests: readonly AgentToolRequest[];
}

/**
 * The model produced an answer that may become completion.
 *
 * A final candidate is only a candidate. `FINAL_CANDIDATE` must move the Run toward
 * verification — never directly to `COMPLETED` — and no shape in the agent kernel can
 * express a completion decision in the first place.
 */
export interface AgentFinalCandidateDecision {
  readonly type: "FINAL_CANDIDATE";
  readonly modelTurn: AgentModelTurn;
  /**
   * The candidate text, taken from the settled turn rather than re-derived from the
   * assistant message.
   *
   * The assistant message is the durable conversation record; the candidate text is the
   * value the Completion Authority hashes into `candidateHash`. Keeping it explicit means
   * no caller ever reconstructs a security-relevant hash by re-rendering a message.
   */
  readonly candidateText: string;
}

/** One thing the model decided to do. */
export type AgentDecision = AgentToolCallsDecision | AgentFinalCandidateDecision;

/** Every frozen decision discriminator, in canonical order. */
export const AGENT_DECISION_TYPES = [
  "TOOL_CALLS_REQUESTED",
  "FINAL_CANDIDATE",
] as const satisfies readonly AgentDecision["type"][];

/* ----------------------------------------------------------- turn projection */

/**
 * Project one settled AI turn onto the frozen agent model turn.
 *
 * This is the only projection from a settled provider turn to `AgentModelTurn`, so a
 * turn that fails classification can still be reported as the settled turn it was —
 * without a second, subtly different reconstruction living next to the classifier's.
 *
 * `undefined` means the turn did not come from the frozen AI contract: an unrecognised
 * finish reason cannot become an `AgentModelTurn`, because the frozen contract names the
 * finish-reason vocabulary and must never carry a foreign value.
 */
export function toAgentModelTurn(result: AIModelTurnResult): AgentModelTurn | undefined {
  if (!isAIFinishReason(result.finishReason)) return undefined;
  return {
    callId: result.callId,
    model: result.model,
    finishReason: result.finishReason,
    assistantMessage: toAssistantMessage(result),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

/**
 * Project the settled turn onto the durable-shaped assistant message.
 *
 * Only the two frozen AI assistant content parts exist, so this projection cannot
 * invent one. Tool-call order is the announcement order the assembler already
 * normalized, which keeps a replayed turn byte-identical.
 */
export function toAssistantMessage(result: AIModelTurnResult): AIAssistantMessage {
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

/** One tool call, projected onto the frozen request shape. Not exported by the package root. */
export function toAgentToolRequest(toolCall: AIToolCall): AgentToolRequest {
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
function toProtocolJsonObject(value: { readonly [key: string]: unknown }): JsonObject {
  const projected: Record<string, import("@caelush/protocol").JsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    projected[key] = toProtocolJsonValue(member);
  }
  return projected;
}

function toProtocolJsonValue(value: unknown): import("@caelush/protocol").JsonValue {
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
