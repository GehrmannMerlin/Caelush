import type {
  JsonObject as AILocalJsonObject,
  JsonValue as AILocalJsonValue,
  ModelRef as AIModelRef,
} from "@caelush/ai";
import type {
  JsonObject as ProtocolJsonObject,
  JsonValue as ProtocolJsonValue,
  ModelRef as ProtocolModelRef,
} from "@caelush/protocol";

/**
 * Project an AI-local JSON object onto the Protocol wire JSON object.
 *
 * The two types describe the same JSON value model, but the AI-local one uses
 * readonly arrays. This conversion is the explicit boundary the V2 design requires:
 * the AI core never depends on Protocol, so the legacy compatibility layer performs
 * the projection and owns the copy.
 *
 * The copy also detaches the value from anything the adapter still holds, so a
 * legacy consumer cannot mutate adapter state through a shared reference.
 */
export function toProtocolJsonObject(value: AILocalJsonObject): ProtocolJsonObject {
  const projected: Record<string, ProtocolJsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    projected[key] = toProtocolJsonValue(member);
  }
  return projected;
}

function toProtocolJsonValue(value: AILocalJsonValue): ProtocolJsonValue {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return (value as readonly AILocalJsonValue[]).map(toProtocolJsonValue);
  }
  return toProtocolJsonObject(value as AILocalJsonObject);
}

/**
 * Project the Protocol model reference onto the AI model reference.
 *
 * The two shapes are semantically identical. `baseUrl` is projected only when it is
 * actually present, because the AI contract declares it as an optional string rather
 * than an optional string-or-undefined. The field is legacy compatibility either way:
 * it never participates in identity, routing or endpoint authority.
 */
export function toAIModelRef(ref: ProtocolModelRef): AIModelRef {
  return ref.baseUrl === undefined
    ? { provider: ref.provider, model: ref.model }
    : { provider: ref.provider, model: ref.model, baseUrl: ref.baseUrl };
}
