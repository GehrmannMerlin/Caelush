import type {
  AIAssistantContent,
  AIMessage,
  AIModelTurnResult,
  AIToolSpec,
  ModelRef as AIModelRef,
} from "@caelush/ai";
import type { AgentDecision, AgentExecutionIdentity, AgentTurnRef } from "@caelush/agent";
import type { LLMAssistantMessage, LLMMessage } from "@caelush/llm/messages";
import type { AgentRetryMetadata } from "./agent-loop-input.js";
import type {
  JsonObject as ProtocolJsonObject,
  JsonValue as ProtocolJsonValue,
  LLMCallId,
  ModelRef,
  ToolDefinition,
} from "@caelush/protocol";

/**
 * TRANSITIONAL — the durable compatibility projection between the AI/Agent contracts and
 * the legacy durable Core types.
 *
 * Phase 3A moved the Agent Kernel contracts into `@caelush/agent`, where they are written
 * in `@caelush/ai` and `@caelush/protocol` types. The Conversation Message System and the
 * durable Storage types are still legacy, so exactly one module — this one — owns the
 * boundary between the two:
 *
 * ```text
 * Agent package never imports @caelush/llm
 * Core legacy facade may import both
 * ```
 *
 * It disappears when Message System V2 owns the durable message contract, and it is
 * deliberately a set of hand-written projections rather than a cast: each function
 * decides field by field what crosses, so nothing can arrive by accident.
 */

/**
 * Project the legacy model reference onto the AI model reference.
 *
 * `baseUrl` is dropped on purpose. Model identity is `provider + model` and the provider
 * binding owns the endpoint, so a legacy or stored `baseUrl` must never be able to
 * influence routing.
 */
export function toAIModelRef(ref: ModelRef): AIModelRef {
  return { provider: ref.provider, model: ref.model };
}

/**
 * Project one legacy message onto the AI message contract.
 *
 * A tool result keeps its success/error distinction and drops `rawArtifactRef`, which is a
 * durable recovery pointer rather than provider input.
 */
export function toAIMessage(message: LLMMessage): AIMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: [...message.content] };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
  }
}

/**
 * Project one AI message onto the durable legacy message contract.
 *
 * This is the reverse of `toAIMessage`, and it exists only because durable conversation is
 * still legacy. An AI assistant message is non-empty by contract, so the projection cannot
 * produce a message the legacy schema would reject.
 */
export function toLegacyMessage(message: AIMessage): LLMMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content.map(toLegacyAssistantContent) };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
  }
}

function toLegacyAssistantContent(
  part: AIAssistantContent,
): LLMAssistantMessage["content"][number] {
  if (part.type === "text") return { type: "text", text: part.text };
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: toProtocolJsonObject(part.input),
  };
}

/**
 * Re-brand one agent decision's model-turn call identity for durable storage.
 *
 * The agent's `AgentModelTurn.callId` is deliberately unbranded: the AI core owns its own
 * branded type because it may not depend on Protocol, and the two are the same
 * `llm_<UUIDv7>` value rather than two encodings of it. This is the single place where it
 * becomes the Protocol `LLMCallId` the continuation schema persists.
 */
export function toDurableCallId(decision: AgentDecision): LLMCallId {
  return decision.modelTurn.callId as LLMCallId;
}

/**
 * Project a settled AI model turn onto the durable legacy assistant message.
 *
 * The turn result is model-execution data; the assistant message is the durable
 * conversation record that Message System V2 will own later. Reasoning summaries are
 * absent from the turn result by construction, so a summary can never become durable
 * assistant content.
 */
export function toLegacyAssistantMessage(result: AIModelTurnResult): LLMAssistantMessage {
  const content: LLMAssistantMessage["content"] = [];
  if (result.text.length > 0) {
    content.push({ type: "text", text: result.text });
  }
  for (const toolCall of result.toolCalls) {
    content.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toProtocolJsonObject(toolCall.input),
    });
  }
  return { role: "assistant", content };
}

/**
 * Project a Caelush tool definition onto the model-facing tool spec.
 *
 * Only `name`, `description` and `inputSchema` cross. `outputSchema`, `riskLevel`,
 * `requiredCapabilities`, `runtimeRequirements` and any handler are Caelush runtime and
 * security metadata: the model must never see them, and the AI tool contract has no field
 * for them in the first place.
 */
export function toAIToolSpec(definition: ToolDefinition): AIToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

/**
 * Project an AI retry code onto the frozen durable spelling.
 *
 * The `retry.scheduled` durable event and the `WAITING_RETRY` continuation store the
 * legacy `LLM_*` spelling, which is part of the Protocol contract and therefore not this
 * phase's to change. The runtime path classifies with AI codes; only the durable artifact
 * keeps the legacy spelling, so existing rows stay readable.
 */
export function toDurableRetryCode(
  code: AgentRetryMetadata["code"],
): "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT" {
  switch (code) {
    case "AI_RATE_LIMIT":
      return "LLM_RATE_LIMIT";
    case "AI_NETWORK":
      return "LLM_NETWORK";
    case "AI_TIMEOUT":
      return "LLM_TIMEOUT";
  }
}

/** Deep-copy an AI-local JSON object into the Protocol JSON value model. */
export function toProtocolJsonObject(value: {
  readonly [key: string]: unknown;
}): ProtocolJsonObject {
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
  // The AI JSON contract admits only JSON-safe values, so this is unreachable for a value
  // that came from an AI turn result.
  throw new TypeError("AI tool input contained a value that is not JSON-safe.");
}

export type { AgentExecutionIdentity, AgentTurnRef };
