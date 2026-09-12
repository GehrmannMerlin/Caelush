import { describe, expect, it } from "vitest";
import { normalizeAISDKUsage } from "../../../src/adapters/openai-compatible/usage-normalizer.js";
import type { LanguageModelUsage } from "ai";

/** Build a usage object in the shape the AI SDK reports. */
function sdkUsage(input: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly reasoningTokens?: number;
}): LanguageModelUsage {
  return {
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    ...(input.totalTokens === undefined ? {} : { totalTokens: input.totalTokens }),
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: undefined,
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
          reasoningTokens: 2,
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 6,
      reasoningTokens: 2,
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
