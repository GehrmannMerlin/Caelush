import { createAIError } from "../../errors/ai-error.js";
import { isJsonObject } from "../../json/json-value.js";
import type { AIError } from "../../errors/ai-error.js";
import type { AIToolCall } from "../../tools/tool-call.js";
import type { JsonObject } from "../../json/json-value.js";
import type { ModelRef } from "../../models/model-ref.js";

/**
 * Parse the accumulated `input_json_delta` text of one native `tool_use` block.
 *
 * The native protocol streams a tool input as a JSON *fragment* sequence, so the
 * value only exists once the block stops. It must be a JSON object: the frozen
 * `AIToolCall.input` is a `JsonObject`, and an array, a primitive, `null` or
 * malformed text is a provider defect that fails closed instead of being coerced
 * with a cast.
 *
 * An empty buffer is the provider's own way of saying "no arguments", and is read
 * as `{}`.
 */
export function parseAnthropicToolInput(
  toolCallId: string,
  accumulated: string,
  model: ModelRef,
): AIToolCall["input"] {
  const text = accumulated.trim();
  if (text.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidToolInput(toolCallId, model);
  }

  if (!isJsonObject(parsed)) throw invalidToolInput(toolCallId, model);
  return parsed as JsonObject;
}

function invalidToolInput(toolCallId: string, model: ModelRef): AIError {
  return createAIError(
    "AI_INVALID_RESPONSE",
    `AI provider returned a tool input for "${toolCallId}" that is not a JSON object.`,
    { providerId: model.provider, model },
  );
}

/** A locally raised dialect failure: never a silent coercion. */
export function dialectFailure(
  code: "AI_INVALID_REQUEST" | "AI_INVALID_RESPONSE" | "AI_CAPABILITY_UNSUPPORTED",
  message: string,
  model: ModelRef,
): AIError {
  return createAIError(code, message, { providerId: model.provider, model });
}
