import { describe, expect, it } from "vitest";
import type { LanguageModelUsage } from "ai";
import { mapFinishReason } from "../src/providers/openai-compatible/finish.js";
import { normalizeAISDKUsage } from "../src/providers/openai-compatible/usage.js";

const usage: LanguageModelUsage = {
  inputTokens: 7,
  inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 2, cacheWriteTokens: undefined },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
  totalTokens: 10,
};

describe("OpenAI-compatible stream metadata normalization", () => {
  it("maps all available usage fields without synthesizing absent fields", () => {
    expect(normalizeAISDKUsage(usage)).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    });
    expect(
      normalizeAISDKUsage({
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["stop", "STOP"],
    ["length", "LENGTH"],
    ["tool-calls", "TOOL_CALLS"],
    ["content-filter", "CONTENT_FILTER"],
    ["error", "OTHER"],
    ["other", "OTHER"],
    ["future-provider-value", "OTHER"],
  ] as const)("maps finish reason %s", (reason, expected) => {
    expect(mapFinishReason(reason)).toBe(expected);
  });
});
