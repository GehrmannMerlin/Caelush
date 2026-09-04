import { describe, expect, it } from "vitest";
import { createContextUsageProjection } from "../src/context-usage-projection.js";

describe("ContextUsageProjection", () => {
  it("rejects an effective budget larger than the raw model window", () => {
    expect(() =>
      createContextUsageProjection({
        runId: "run-1",
        providerId: "fixture",
        modelId: "fixture-model",
        contextWindowTokens: 100,
        rawContextWindowTokens: 100,
        effectiveInputLimitTokens: 101,
        estimatedInputTokens: 1,
        pressureState: "NORMAL",
        compactionCount: 0,
        breakdown: {
          pinned: 0,
          checkpoint: 0,
          recentTail: 0,
          project: 0,
          files: 0,
          toolObservations: 0,
          memory: 0,
        },
        updatedAt: 1,
      }),
    ).toThrow(RangeError);
  });

  it("reports current working context used ratio against effective input capacity", () => {
    const usage = createContextUsageProjection({
      runId: "run-1",
      providerId: "fixture",
      modelId: "fixture-model",
      contextWindowTokens: 36_608,
      effectiveInputLimitTokens: 32_000,
      estimatedInputTokens: 23_040,
      pressureState: "PROACTIVE",
      compactionCount: 1,
      breakdown: {
        pinned: 100,
        checkpoint: 200,
        recentTail: 500,
        project: 300,
        files: 400,
        toolObservations: 11_000,
        memory: 540,
      },
      updatedAt: 42,
    });

    expect(usage.usedRatio).toBeCloseTo(0.72);
    expect(usage.remainingTokens).toBe(8_960);
    expect(usage.breakdown.toolObservations).toBe(11_000);
  });

  it("clamps invalid estimates and preserves a safe empty state", () => {
    const usage = createContextUsageProjection({
      runId: "run-1",
      providerId: "fixture",
      modelId: "fixture-model",
      contextWindowTokens: 100,
      effectiveInputLimitTokens: 80,
      estimatedInputTokens: 200,
      pressureState: "EMERGENCY",
      compactionCount: 0,
      breakdown: {
        pinned: 0,
        checkpoint: 0,
        recentTail: 0,
        project: 0,
        files: 0,
        toolObservations: 0,
        memory: 0,
      },
      updatedAt: 42,
    });
    expect(usage.usedRatio).toBe(1);
    expect(usage.remainingTokens).toBe(0);
  });
});
