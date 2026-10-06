import * as protocol from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const baseUsage = {
  runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  providerId: "fixture-provider",
  modelId: "fixture-model",
  contextWindowTokens: 16_000,
  effectiveInputLimitTokens: 12_000,
  estimatedInputTokens: 4_000,
  usedRatio: 1 / 3,
  remainingTokens: 8_000,
  pressureState: "NORMAL",
  compactionCount: 0,
  breakdown: {
    pinned: 500,
    checkpoint: 0,
    recentTail: 1_000,
    project: 0,
    files: 0,
    toolObservations: 0,
    memory: 0,
  },
  updatedAt: 1_700_000_000_000,
} as const;

const basePromptCache = {
  sampleCount: 2,
  totalRequestCount: 3,
  totalInputTokens: 2_000,
  totalOutputTokens: 200,
  hitTokens: 1_700,
  missTokens: 300,
  writeTokens: 80,
  unknownUsageCount: 1,
  latestHitRate: 0.9,
  rollingHitRate: 0.85,
  expectedReusablePrefixTokens: 2_000,
  reusablePrefixEfficiency: 0.85,
  epochId: "epoch-safe-1",
  resetReason: "INITIAL",
  lastMeasuredAt: 1_700_000_000_001,
  purposes: [
    {
      purpose: "MAIN_AGENT",
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      hitTokens: 1_700,
      missTokens: 300,
      writeTokens: 80,
      unknownUsageCount: 0,
    },
    {
      purpose: "COMPACTION",
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      writeTokens: 0,
      unknownUsageCount: 1,
    },
  ],
} as const;

describe("Context Usage Protocol projection", () => {
  it("exports the prompt-cache schemas from the package root", () => {
    expect(protocol.PromptCacheStatusSchema).toBeDefined();
    expect(protocol.PromptCacheRequestPurposeSchema).toBeDefined();
    expect(protocol.PromptCacheUsageSchema).toBeDefined();
  });

  it.each(["WARM", "COLD_START", "RESET", "UNREPORTED"] as const)(
    "accepts the %s prompt-cache status",
    (status) => {
      const promptCache =
        status === "UNREPORTED"
          ? {
              status,
              sampleCount: 0,
              totalRequestCount: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              hitTokens: 0,
              missTokens: 0,
              writeTokens: 0,
              unknownUsageCount: 0,
              expectedReusablePrefixTokens: 0,
              purposes: [],
            }
          : { status, ...basePromptCache };

      expect(
        protocol.ContextUsageProjectionSchema.parse({ ...baseUsage, promptCache }).promptCache
          ?.status,
      ).toBe(status);
    },
  );

  it("keeps purpose buckets bounded to closed values and safe token counts", () => {
    const parsed = protocol.ContextUsageProjectionSchema.parse({
      ...baseUsage,
      promptCache: { status: "WARM", ...basePromptCache },
    });
    expect(parsed.promptCache?.purposes).toHaveLength(2);
    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        promptCache: {
          status: "WARM",
          ...basePromptCache,
          purposes: [{ ...basePromptCache.purposes[0], purpose: "CUSTOM" }],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts reset step/time together and rejects a partial reset marker", () => {
    const resetPromptCache = {
      status: "RESET",
      ...basePromptCache,
      resetReason: "CACHE_SETTINGS_CHANGED",
      resetStepSequence: 3,
      resetAt: 1_700_000_000_003,
    };
    expect(
      protocol.ContextUsageProjectionSchema.parse({ ...baseUsage, promptCache: resetPromptCache })
        .promptCache,
    ).toMatchObject({ resetStepSequence: 3, resetAt: 1_700_000_000_003 });
    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        promptCache: { ...resetPromptCache, resetAt: undefined },
      }).success,
    ).toBe(false);
  });

  it.each([
    { latestHitRate: Number.NaN },
    { latestHitRate: Number.POSITIVE_INFINITY },
    { rollingHitRate: -0.01 },
    { reusablePrefixEfficiency: 1.01 },
    { hitTokens: -1 },
    { missTokens: 1.5 },
    { sampleCount: Number.MAX_SAFE_INTEGER + 1 },
    { resetReason: "RAW_EXCEPTION_TEXT" },
    { purposes: [{ ...basePromptCache.purposes[0], inputTokens: -1 }] },
  ])("rejects malformed prompt-cache fields: %o", (patch) => {
    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        promptCache: { status: "WARM", ...basePromptCache, ...patch },
      }).success,
    ).toBe(false);
  });

  it("requires unreported rates to stay absent and accepts legacy payloads", () => {
    const unreported = {
      status: "UNREPORTED",
      sampleCount: 0,
      totalRequestCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      writeTokens: 0,
      unknownUsageCount: 1,
      expectedReusablePrefixTokens: 500,
      purposes: [
        {
          purpose: "MAIN_AGENT",
          requestCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          writeTokens: 0,
          unknownUsageCount: 1,
        },
      ],
    };
    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        promptCache: { ...unreported, latestHitRate: 0 },
      }).success,
    ).toBe(false);
    expect(protocol.ContextUsageProjectionSchema.parse(baseUsage)).toEqual(baseUsage);
    expect(protocol.ContextUsageResponseSchema.parse(null)).toBeNull();
  });
});
