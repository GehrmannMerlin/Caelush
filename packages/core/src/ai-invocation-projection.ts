import type {
  AIMessage,
  AIModelTurnResult,
  AIToolCall,
  AIToolSpec,
  ModelRef as AIModelRef,
} from "@caelush/ai";
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
 * TRANSITIONAL — the legacy-core to AI-contract projection.
 *
 * Phase 2C cuts the Core model execution path over to the frozen AI contracts while
 * the Conversation Message System and the durable Storage types stay legacy. This
 * module is the explicit boundary between the two, and it disappears when those
 * subsystems own V2 contracts.
 *
 * It is deliberately a set of hand-written projections, never a cast: each function
 * decides field by field what crosses, so nothing can arrive by accident.
 */

/**
 * Project the legacy model reference onto the AI model reference.
 *
 * `baseUrl` is dropped on purpose. Model identity is `provider + model` and the
 * provider binding owns the endpoint, so a legacy or stored `baseUrl` must never be
 * able to influence routing.
 */
export function toAIModelRef(ref: ModelRef): AIModelRef {
  return { provider: ref.provider, model: ref.model };
}

/**
 * Project one legacy message onto the AI message contract.
 *
 * A tool result keeps its success/error distinction and drops `rawArtifactRef`,
 * which is a durable recovery pointer rather than provider input.
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
 * Project a Caelush tool definition onto the model-facing tool spec.
 *
 * Only `name`, `description` and `inputSchema` cross. `outputSchema`, `riskLevel`,
 * `requiredCapabilities`, `runtimeRequirements` and any handler are Caelush runtime
 * and security metadata: the model must never see them, and the AI tool contract has
 * no field for them in the first place.
 */
export function toAIToolSpec(definition: ToolDefinition): AIToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

/**
 * Project a settled AI model turn onto the durable legacy assistant message.
 *
 * The turn result is model-execution data; the assistant message is the durable
 * conversation record that Message System V2 will own later. Reasoning summaries are
 * absent from the turn result by construction, so a summary can never become durable
 * assistant content.
 */
export function toProtocolAssistantMessage(result: AIModelTurnResult): LLMAssistantMessage {
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
 * Project one completed AI tool call's arguments onto the Protocol JSON object.
 *
 * Tool arguments are durable once a call is completed, so they are copied rather
 * than shared with the adapter that produced them.
 */
export function toProtocolToolInput(toolCall: AIToolCall): ProtocolJsonObject {
  return toProtocolJsonObject(toolCall.input);
}

/**
 * Project the AI call identity onto the Protocol wire identity.
 *
 * Both are the same `llm_<UUIDv7>` string: the AI core owns its own branded type
 * because it may not depend on Protocol, and this is the boundary where the two
 * identities meet. The value is not reinterpreted, only re-branded.
 */
export function toProtocolCallId(callId: string): LLMCallId {
  return callId as LLMCallId;
}

/**
 * Project an AI retry code onto the frozen durable spelling.
 *
 * The `retry.scheduled` durable event and the `WAITING_RETRY` continuation store the
 * legacy `LLM_*` spelling, which is part of the Protocol contract and therefore not
 * this phase's to change. The runtime path classifies with AI codes; only the durable
 * artefact keeps the legacy spelling, so existing rows stay readable.
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
  // The AI JSON contract admits only JSON-safe values, so this is unreachable for a
  // value that came from an AI turn result.
  throw new TypeError("AI tool input contained a value that is not JSON-safe.");
}
