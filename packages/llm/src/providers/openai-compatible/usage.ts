import type { LanguageModelUsage } from "ai";
import type { LLMUsage } from "../../usage.js";

export function normalizeAISDKUsage(usage: LanguageModelUsage | undefined): LLMUsage | undefined {
  if (usage === undefined) return undefined;

  const normalized: LLMUsage = {
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
