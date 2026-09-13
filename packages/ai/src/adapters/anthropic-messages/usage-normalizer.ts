import { isJsonObject } from "../../json/json-value.js";
import type { ModelUsage } from "../../models/model-usage.js";

/**
 * Normalise a native Anthropic usage object onto the frozen `ModelUsage` contract.
 *
 * ```text
 * input_tokens                -> inputTokens
 * output_tokens               -> outputTokens
 * cache_read_input_tokens     -> cachedInputTokens
 * output_tokens_details.thinking_tokens -> reasoningTokens   (only when reported)
 * totalTokens                 -> inputTokens + outputTokens  (when both are known)
 * ```
 *
 * `cache_read_input_tokens` is a *subset* of `input_tokens`, so it is never added
 * to the total. `cache_creation_input_tokens` describes writing a cache entry, has
 * no frozen field, and is deliberately dropped rather than folded into
 * `cachedInputTokens`, which would misreport a cache write as a cache read.
 *
 * A counter the provider did not report stays absent; `0` would be a claim the
 * provider never made.
 */
export function normalizeAnthropicUsage(value: unknown): ModelUsage | undefined {
  if (!isJsonObject(value)) return undefined;

  const inputTokens = readCount(value["input_tokens"]);
  const outputTokens = readCount(value["output_tokens"]);
  const cachedInputTokens = readCount(value["cache_read_input_tokens"]);
  const reasoningTokens = readReasoningTokens(value["output_tokens_details"]);

  const totalTokens =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : safeSum(inputTokens, outputTokens);

  const usage: ModelUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };

  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * Merge a newer native usage snapshot over an older one.
 *
 * The native protocol reports usage as cumulative *snapshots*, not as deltas:
 * `message_start` carries the input counters, `message_delta` carries the final
 * output counters, and each snapshot restates what the provider knows. Merging is
 * therefore a field-wise overlay, never an addition — summing the snapshots would
 * multiply the token count of every turn.
 */
export function mergeAnthropicUsage(
  previous: ModelUsage | undefined,
  next: ModelUsage | undefined,
): ModelUsage | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;

  const merged: ModelUsage = {
    ...previous,
    ...next,
  };

  // The total is derived, so it is recomputed from the merged counters instead of
  // being inherited from whichever snapshot happened to carry one.
  const totalTokens =
    merged.inputTokens === undefined || merged.outputTokens === undefined
      ? merged.totalTokens
      : safeSum(merged.inputTokens, merged.outputTokens);

  return {
    ...(merged.inputTokens === undefined ? {} : { inputTokens: merged.inputTokens }),
    ...(merged.outputTokens === undefined ? {} : { outputTokens: merged.outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(merged.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: merged.cachedInputTokens }),
    ...(merged.reasoningTokens === undefined ? {} : { reasoningTokens: merged.reasoningTokens }),
  };
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * Read the reasoning-token counter only from its explicit native location.
 *
 * The dialect reports thinking tokens under `output_tokens_details.thinking_tokens`
 * when it reports them at all. Nothing is inferred from the presence of thinking
 * content: a model that thinks without reporting the count leaves the field absent.
 */
function readReasoningTokens(details: unknown): number | undefined {
  if (!isJsonObject(details)) return undefined;
  return readCount(details["thinking_tokens"]);
}

function safeSum(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}
