import { createAIError } from "../../errors/ai-error.js";
import type { ModelDescriptor } from "../../models/model-descriptor.js";
import type { ReasoningLevel } from "../../reasoning/reasoning-level.js";
import type { ResolvedAIModelRequest } from "../../request/resolved-model-request.js";

/**
 * Provider-native options for the OpenAI-compatible chat dialect.
 *
 * These names exist only inside this adapter. The AI core expresses intent in
 * semantic levels; turning a level into a provider option is dialect business.
 */
export interface OpenAICompatibleNativeOptions {
  readonly reasoningEffort?: string;
}

/** The adapterMetadata / compatibility namespace this dialect owns. */
export const OPENAI_COMPATIBLE_METADATA_NAMESPACE = "openai-compatible";

/**
 * Levels with a standard value in this dialect, and the native spelling.
 *
 * `OFF` is deliberately absent: it means "do not steer reasoning", so the option
 * is omitted rather than sent as an invented `none` value.
 *
 * A host may override or extend this table per model through
 * `ModelDescriptor.adapterMetadata["openai-compatible"].reasoningEffortByLevel`.
 * No provider name is ever inspected — a dialect that accepts `xhigh` says so in
 * metadata instead of being recognised by its id.
 */
const NATIVE_REASONING_EFFORT: Partial<Record<ReasoningLevel, string>> = {
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

/** Resolve the native request options for one prepared invocation. */
export function resolveOpenAICompatibleNativeOptions(
  model: ModelDescriptor,
  request: ResolvedAIModelRequest,
): OpenAICompatibleNativeOptions {
  const reasoningEffort = resolveReasoningEffort(model, request);
  // A cache retention this dialect cannot express is a configuration contradiction
  // rather than something to drop, because the resolution already reported the
  // effective retention to the caller.
  const cacheRetention = request.settings.cache.effective;
  if (cacheRetention !== "NONE") {
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      `The OpenAI-compatible chat dialect has no prompt-cache control, so the effective cache retention "${cacheRetention}" cannot be applied.`,
      { providerId: model.ref.provider, model: model.ref },
    );
  }

  return reasoningEffort === undefined ? {} : { reasoningEffort };
}

function resolveReasoningEffort(
  model: ModelDescriptor,
  request: ResolvedAIModelRequest,
): string | undefined {
  const effective = request.settings.reasoning.effective;
  if (effective === undefined || effective === "OFF") return undefined;

  const override = reasoningEffortOverrides(model)[effective];
  const effort = typeof override === "string" && override.length > 0 ? override : undefined;
  const resolved = effort ?? NATIVE_REASONING_EFFORT[effective];

  if (resolved === undefined) {
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      `The OpenAI-compatible chat dialect has no native reasoning effort for the effective level "${effective}".`,
      { providerId: model.ref.provider, model: model.ref },
    );
  }
  return resolved;
}

/** Read the adapter-private per-model native effort overrides. */
function reasoningEffortOverrides(
  model: ModelDescriptor,
): Partial<Record<ReasoningLevel, unknown>> {
  const namespace: unknown = model.adapterMetadata?.[OPENAI_COMPATIBLE_METADATA_NAMESPACE];
  if (!isPlainRecord(namespace)) return {};

  const overrides: unknown = namespace["reasoningEffortByLevel"];
  if (!isPlainRecord(overrides)) return {};
  return overrides as Partial<Record<ReasoningLevel, unknown>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrap the native options in the provider-options envelope the SDK expects.
 *
 * The SDK keys provider options by the provider `name` it was constructed with, so
 * the adapter's own binding id is the key. The camelCase spelling is the preferred
 * form: the pinned SDK reads both spellings but warns that the raw one is
 * deprecated, and `toProviderOptionsKey` mirrors the SDK's own transformation so
 * the two can never drift.
 */
export function toOpenAICompatibleProviderOptions(
  providerName: string,
  native: OpenAICompatibleNativeOptions,
): Record<string, Record<string, string>> | undefined {
  const options: Record<string, string> = {};
  if (native.reasoningEffort !== undefined) options["reasoningEffort"] = native.reasoningEffort;
  if (Object.keys(options).length === 0) return undefined;
  return { [toProviderOptionsKey(providerName)]: options };
}

/**
 * The provider-options key for a provider name.
 *
 * Mirrors the pinned SDK's `toCamelCase` exactly: an underscore or hyphen before a
 * lowercase letter is removed and the letter is upper-cased.
 */
export function toProviderOptionsKey(providerName: string): string {
  return providerName.replace(/[_-]([a-z])/g, (match) => match[1]?.toUpperCase() ?? match);
}
