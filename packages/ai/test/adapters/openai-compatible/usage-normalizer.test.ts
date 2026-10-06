import { describe, expect, it } from "vitest";
import {
  mergeOpenAICompatibleUsage,
  normalizeAISDKUsage,
} from "../../../src/adapters/openai-compatible/usage-normalizer.js";
import { parseOpenAICompatibleRawUsage } from "../../../src/adapters/openai-compatible/raw-usage.js";
import type { LanguageModelUsage } from "ai";

/** Build a usage object in the shape the AI SDK reports. */
function sdkUsage(input: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}): LanguageModelUsage {
  return {
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    ...(input.totalTokens === undefined ? {} : { totalTokens: input.totalTokens }),
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: input.reasoningTokens,
    },
  } as LanguageModelUsage;
}

describe("AI SDK usage normalization", () => {
  it("maps every reported counter", () => {
    expect(
      normalizeAISDKUsage(
        sdkUsage({
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadTokens: 6,
          cacheWriteTokens: 3,
          reasoningTokens: 2,
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 6,
      reasoningTokens: 2,
      cacheWriteInputTokens: 3,
    });
  });

  it("keeps only the counters the provider actually reported", () => {
    expect(normalizeAISDKUsage(sdkUsage({ inputTokens: 10 }))).toEqual({ inputTokens: 10 });
    expect(normalizeAISDKUsage(sdkUsage({ outputTokens: 0 }))).toEqual({ outputTokens: 0 });
  });

  it("never fabricates a zero for a missing counter", () => {
    const normalized = normalizeAISDKUsage(sdkUsage({ inputTokens: 10 }));

    expect(normalized).not.toHaveProperty("outputTokens");
    expect(normalized).not.toHaveProperty("totalTokens");
    expect(normalized).not.toHaveProperty("cachedInputTokens");
    expect(normalized).not.toHaveProperty("reasoningTokens");
  });

  it("returns undefined for no usage and for an empty usage", () => {
    expect(normalizeAISDKUsage(undefined)).toBeUndefined();
    expect(normalizeAISDKUsage(sdkUsage({}))).toBeUndefined();
  });
});

describe("OpenAI-compatible raw usage", () => {
  it("parses DeepSeek native hit/miss and standard cached-token details", () => {
    expect(
      parseOpenAICompatibleRawUsage({
        prompt_tokens: 1_000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 970 },
        prompt_cache_hit_tokens: 970,
        prompt_cache_miss_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    ).toEqual({
      promptTokens: 1_000,
      cacheHitTokens: 970,
      cacheMissTokens: 30,
      completionTokens: 10,
      reasoningTokens: 2,
    });
  });

  it("rejects conflicting native and standard cache-hit fields", () => {
    expect(() =>
      parseOpenAICompatibleRawUsage({
        prompt_tokens_details: { cached_tokens: 970 },
        prompt_cache_hit_tokens: 969,
      }),
    ).toThrow();
  });

  it("merges raw hit/miss into SDK usage without adding cache buckets to totals", () => {
    const rawUsage = parseOpenAICompatibleRawUsage({
      prompt_tokens: 1_000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 970 },
      prompt_cache_hit_tokens: 970,
      prompt_cache_miss_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 2 },
    });

    expect(
      mergeOpenAICompatibleUsage(
        sdkUsage({
          inputTokens: 1_000,
          outputTokens: 10,
          totalTokens: 1_010,
          cacheReadTokens: 970,
          reasoningTokens: 2,
        }),
        rawUsage,
      ),
    ).toEqual({
      inputTokens: 1_000,
      outputTokens: 10,
      totalTokens: 1_010,
      cachedInputTokens: 970,
      cacheMissInputTokens: 30,
      reasoningTokens: 2,
    });
  });

  it("fails closed when raw provider values disagree with SDK values", () => {
    const rawUsage = parseOpenAICompatibleRawUsage({
      prompt_tokens: 1_000,
      prompt_cache_hit_tokens: 970,
      prompt_cache_miss_tokens: 30,
    });

    expect(() =>
      mergeOpenAICompatibleUsage(sdkUsage({ inputTokens: 999, cacheReadTokens: 969 }), rawUsage),
    ).toThrow();
  });

  it("fails closed when a complete prompt count disagrees with hit plus miss", () => {
    const rawUsage = parseOpenAICompatibleRawUsage({
      prompt_tokens: 1_000,
      prompt_cache_hit_tokens: 970,
      prompt_cache_miss_tokens: 29,
    });

    expect(() => mergeOpenAICompatibleUsage(undefined, rawUsage)).toThrow();
  });

  it("fails closed on safe-integer overflow while validating the complete prompt", () => {
    const rawUsage = parseOpenAICompatibleRawUsage({
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER,
      prompt_cache_miss_tokens: 1,
    });

    expect(() => mergeOpenAICompatibleUsage(undefined, rawUsage)).toThrow();
  });

  it("preserves partial usage without fabricating missing hit or miss counters", () => {
    const rawUsage = parseOpenAICompatibleRawUsage({
      prompt_tokens: 1_000,
      prompt_cache_hit_tokens: 970,
    });

    const merged = mergeOpenAICompatibleUsage(sdkUsage({ inputTokens: 1_000 }), rawUsage);
    expect(merged).toEqual({ inputTokens: 1_000, cachedInputTokens: 970 });
    expect(merged).not.toHaveProperty("cacheMissInputTokens");
  });
});
