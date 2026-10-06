import type { LanguageModelUsage } from "ai";
import type { ModelUsage } from "../../models/model-usage.js";
import type { OpenAICompatibleRawUsage } from "./raw-usage.js";

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
    cacheWriteInputTokens?: number;
  } = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/** Merge the SDK's normalized view with adapter-private raw provider counters. */
export function mergeOpenAICompatibleUsage(
  sdkUsage: LanguageModelUsage | undefined,
  rawUsage: OpenAICompatibleRawUsage | undefined,
): ModelUsage | undefined {
  const normalized = normalizeAISDKUsage(sdkUsage);
  const inputTokens = reconcile(normalized?.inputTokens, rawUsage?.promptTokens);
  const outputTokens = reconcile(normalized?.outputTokens, rawUsage?.completionTokens);
  const cachedInputTokens = reconcile(normalized?.cachedInputTokens, rawUsage?.cacheHitTokens);
  const reasoningTokens = reconcile(normalized?.reasoningTokens, rawUsage?.reasoningTokens);
  const cacheMissInputTokens = rawUsage?.cacheMissTokens;
  const cacheWriteInputTokens = normalized?.cacheWriteInputTokens;

  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheMissInputTokens !== undefined
  ) {
    const promptBreakdown = safeSum(cachedInputTokens, cacheMissInputTokens);
    if (promptBreakdown === undefined || promptBreakdown !== inputTokens) {
      throw new Error("OpenAI-compatible prompt usage counters disagreed.");
    }
  }

  const derivedTotal =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : safeSum(inputTokens, outputTokens);
  if (inputTokens !== undefined && outputTokens !== undefined && derivedTotal === undefined) {
    throw new Error("OpenAI-compatible usage total overflowed.");
  }
  if (
    normalized?.totalTokens !== undefined &&
    derivedTotal !== undefined &&
    normalized.totalTokens !== derivedTotal
  ) {
    throw new Error("OpenAI-compatible total usage counters disagreed.");
  }
  const totalTokens = normalized?.totalTokens ?? derivedTotal;

  const usage: ModelUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  };

  return Object.keys(usage).length === 0 ? undefined : usage;
}

function reconcile(sdkCount: number | undefined, rawCount: number | undefined): number | undefined {
  if (sdkCount !== undefined && rawCount !== undefined && sdkCount !== rawCount) {
    throw new Error("OpenAI-compatible usage counters disagreed.");
  }
  return rawCount ?? sdkCount;
}

function safeSum(left: number, right: number): number | undefined {
  if (left > Number.MAX_SAFE_INTEGER - right) return undefined;
  return left + right;
}
