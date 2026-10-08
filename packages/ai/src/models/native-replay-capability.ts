import { createAIError } from "../errors/ai-error.js";
import type { ModelDescriptor } from "./model-descriptor.js";

/** Whether this exact model descriptor requires native reasoning history when Tools are sent. */
export function requiresReasoningReplayWithTools(model: ModelDescriptor): boolean {
  const namespace: unknown = model.adapterMetadata?.["openai-compatible"];
  if (namespace === undefined) return false;
  if (!isPlainRecord(namespace)) {
    throw createAIError(
      "AI_INVALID_REQUEST",
      "OpenAI-compatible model replay metadata is invalid.",
      { providerId: model.ref.provider, model: model.ref },
    );
  }
  const capability = namespace["requiresReasoningReplayWithTools"];
  if (capability === undefined) return false;
  if (typeof capability !== "boolean") {
    throw createAIError(
      "AI_INVALID_REQUEST",
      "OpenAI-compatible model replay metadata is invalid.",
      { providerId: model.ref.provider, model: model.ref },
    );
  }
  return capability;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
