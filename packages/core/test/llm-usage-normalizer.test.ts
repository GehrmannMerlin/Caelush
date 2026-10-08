import { describe, expect, it } from "vitest";
import { normalizeLLMUsageForBudget } from "../src/llm-usage-normalizer.js";

describe("LLM budget usage normalization", () => {
  it("preserves cache buckets without adding them to total tokens", () => {
    expect(
      normalizeLLMUsageForBudget({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedInputTokens: 80,
        reasoningTokens: 20,
        cacheMissInputTokens: 20,
        cacheWriteInputTokens: 5,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 80,
      cacheMissInputTokens: 20,
      cacheWriteInputTokens: 5,
      reasoningTokens: 20,
      confidence: "EXACT",
    });
  });

  it.each([
    ["cachedInputTokens", { cachedInputTokens: -1 }],
    ["cacheMissInputTokens", { cacheMissInputTokens: -1 }],
    ["cacheWriteInputTokens", { cacheWriteInputTokens: 1.5 }],
  ] as const)("keeps an invalid %s bucket conservative", (_field, bucket) => {
    expect(normalizeLLMUsageForBudget({ inputTokens: 4, outputTokens: 2, ...bucket })).toEqual({
      confidence: "CONSERVATIVE",
    });
  });

  it("keeps missing or inconsistent usage conservative", () => {
    expect(normalizeLLMUsageForBudget(undefined)).toEqual({ confidence: "UNKNOWN" });
    expect(
      normalizeLLMUsageForBudget({ inputTokens: 100, outputTokens: 50, totalTokens: 120 }),
    ).toMatchObject({ confidence: "CONSERVATIVE", totalTokens: 150 });
  });

  it("reports actual usage greater than the reservation truthfully", () => {
    expect(
      normalizeLLMUsageForBudget(
        { inputTokens: 80, outputTokens: 40 },
        { reservedTotalTokens: 100 },
      ),
    ).toMatchObject({ totalTokens: 120, exceedsReservation: true });
  });
});
