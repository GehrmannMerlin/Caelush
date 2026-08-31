import { describe, expect, it } from "vitest";
import { normalizeLLMUsageForBudget } from "../src/llm-usage-normalizer.js";

describe("LLM budget usage normalization", () => {
  it("uses total tokens without adding cached or reasoning subsets", () => {
    expect(
      normalizeLLMUsageForBudget({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedInputTokens: 80,
        reasoningTokens: 20,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, confidence: "EXACT" });
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
