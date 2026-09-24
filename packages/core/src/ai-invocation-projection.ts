import type { ModelRef as AIModelRef } from "@caelush/ai";
import type { AgentDecision, AgentExecutionIdentity, AgentTurnRef } from "@caelush/agent";
import type { AgentRetryMetadata } from "./agent-loop-input.js";
import type {
  JsonObject as ProtocolJsonObject,
  JsonValue as ProtocolJsonValue,
  LLMCallId,
  ModelRef,
} from "@caelush/protocol";

/** Small Core projections that are not Message System compatibility shims. */

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
 * Project a Caelush tool definition onto the model-facing tool spec.
 *
 * Only `name`, `description` and `inputSchema` cross. `outputSchema`, `riskLevel`,
 * `requiredCapabilities`, `runtimeRequirements` and any handler are Caelush runtime and
 * security metadata: the model must never see them, and the AI tool contract has no field
 * for them in the first place.
 *
 * Retired in Phase 4F.
 *
 * ```text
 * BEFORE   protocol.ToolDefinition (7 fields)  →  AIToolSpec (3 fields)   one projection per turn
 * AFTER    AgentToolRegistry.modelSpecs()      →  AIToolSpec              the stored value itself
 * ```
 *
 * The registry already keeps a Tool's model-facing spec in the exact shape the model receives, so the
 * projection had nothing left to do. Keeping it would have preserved a second place where a provider
 * request is assembled from a wider structure, and the wide structure no longer exists.
 */

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
