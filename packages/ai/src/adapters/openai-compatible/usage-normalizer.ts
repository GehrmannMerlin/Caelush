import type { LanguageModelUsage } from "ai";
import type { ModelUsage } from "../../models/model-usage.js";

/**
 * Normalise the AI SDK usage snapshot onto the frozen `ModelUsage` contract.
 *
 * Only counters the provider actually reported are copied. A missing counter stays
 * absent rather than becoming `0`, because `0` would be a claim the provider never
 * made. `cachedInputTokens` and `reasoningTokens` are the SDK's detail fields and
 * are subsets of the totals, never additional totals.
 */
export function normalizeAISDKUsage(usage: LanguageModelUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;

  const normalized: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  } = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}
