import { describe, expect, it } from "vitest";
import { CapabilitySupportSchema, LLMCapabilitiesSchema, LLMUsageSchema } from "../src/index.js";

describe("LLM capabilities and usage", () => {
  it("distinguishes supported, unsupported, and unknown capability states", () => {
    expect(CapabilitySupportSchema.parse("SUPPORTED")).toBe("SUPPORTED");
    expect(CapabilitySupportSchema.parse("UNSUPPORTED")).toBe("UNSUPPORTED");
    expect(CapabilitySupportSchema.parse("UNKNOWN")).toBe("UNKNOWN");
    expect(
      LLMCapabilitiesSchema.parse({
        textStreaming: "SUPPORTED",
        toolCalling: "UNKNOWN",
        parallelToolCalls: "UNSUPPORTED",
        structuredOutput: "UNKNOWN",
        vision: "UNSUPPORTED",
        reasoningSummary: "UNKNOWN",
      }),
    ).toEqual({
      textStreaming: "SUPPORTED",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNSUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoningSummary: "UNKNOWN",
    });
  });

  it("omits unknown limits and accepts only positive integer limits", () => {
    expect(
      LLMCapabilitiesSchema.parse({
        textStreaming: "SUPPORTED",
        toolCalling: "SUPPORTED",
        parallelToolCalls: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        vision: "UNKNOWN",
        reasoningSummary: "UNKNOWN",
      }),
    ).not.toHaveProperty("contextWindowTokens");
    expect(
      LLMCapabilitiesSchema.safeParse({
        textStreaming: "SUPPORTED",
        toolCalling: "SUPPORTED",
        parallelToolCalls: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        vision: "UNKNOWN",
        reasoningSummary: "UNKNOWN",
        contextWindowTokens: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps usage fields optional and never fabricates missing values", () => {
    expect(LLMUsageSchema.parse({ inputTokens: 12, totalTokens: 12 })).toEqual({
      inputTokens: 12,
      totalTokens: 12,
    });
    expect(LLMUsageSchema.parse({})).toEqual({});
    expect(LLMUsageSchema.safeParse({ outputTokens: -1 }).success).toBe(false);
    expect(LLMUsageSchema.safeParse({ outputTokens: 1.25 }).success).toBe(false);
    expect(LLMUsageSchema.safeParse({ inputTokens: 0 }).success).toBe(true);
  });
});
