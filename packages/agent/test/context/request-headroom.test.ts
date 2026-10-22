import { describe, expect, it } from "vitest";

import {
  computeRequestHeadroom,
  decideTurnBudget,
  resolveOutputAllowance,
  resolveTurnBudgetPolicy,
} from "../../src/context/policy/request-headroom.js";
import { createContextPolicy } from "../../src/context/policy/context-policy.js";
import type { ModelDescriptor } from "@caelush/ai";

const MEGA_WINDOW = 1_048_576;

function model(window: number, maxOutputTokens: number): ModelDescriptor {
  return {
    ref: { provider: "test", model: "headroom" },
    limits: { contextWindowTokens: window, maxOutputTokens },
    capabilities: {
      tools: true,
      toolChoice: true,
      streaming: true,
      parallelToolCalls: true,
      reasoning: false,
      cache: false,
      vision: false,
      jsonMode: false,
    },
  } as unknown as ModelDescriptor;
}

describe("HEADROOM_V1 output allowance", () => {
  it("keeps the preferred allowance when a large window has a small input", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
    });
    const allowance = resolveOutputAllowance({
      policy,
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
      fullInputTokens: Math.floor(MEGA_WINDOW * 0.08),
    });
    // The whole point of the change: a 1M window does not reserve 65k (or 96k, or a fixed 72k
    // trigger). It asks for the preferred allowance and leaves the rest of the window to history.
    expect(allowance).toBe(policy.preferredOutputTokens);
    expect(allowance).toBeLessThan(65_536);
  });

  it("shrinks the allowance before any history is touched when the input is large", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
    });
    const allowance = resolveOutputAllowance({
      policy,
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
      fullInputTokens: MEGA_WINDOW - policy.safetyTokens - policy.expectedGrowthTokens - 4_096,
    });
    expect(allowance).toBe(4_096);
    expect(allowance).toBeGreaterThanOrEqual(policy.minOutputTokens);
  });

  it("never asks for more than an explicit generation preference", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
      configuredOutputCeiling: 4_096,
    });
    const allowance = resolveOutputAllowance({
      policy,
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
      fullInputTokens: 1_000,
      configuredOutputCeiling: 4_096,
    });
    expect(allowance).toBe(4_096);
    expect(policy.minOutputTokens).toBeLessThanOrEqual(4_096);
  });

  it("keeps the minimum allowance even when the input leaves no room", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
    });
    const allowance = resolveOutputAllowance({
      policy,
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
      fullInputTokens: MEGA_WINDOW,
    });
    expect(allowance).toBe(policy.minOutputTokens);
  });
});

describe("HEADROOM_V1 preparation condition", () => {
  it("does not need preparation when the next turn's growth still fits", () => {
    const headroom = computeRequestHeadroom({
      windowTokens: 1_048_576,
      fullInputTokens: 84_000,
      outputAllowanceTokens: 16_384,
      safetyTokens: 4_096,
      expectedGrowthTokens: 16_384,
    });
    expect(headroom.fitsCurrentRequest).toBe(true);
    expect(headroom.needsPreparation).toBe(false);
    expect(headroom.remainingTokens).toBe(1_048_576 - 84_000 - 16_384 - 4_096);
  });

  it("needs preparation exactly when the remaining room falls below the growth", () => {
    const headroom = computeRequestHeadroom({
      windowTokens: 200_000,
      fullInputTokens: 160_000,
      outputAllowanceTokens: 16_384,
      safetyTokens: 1_000,
      expectedGrowthTokens: 16_384,
    });
    expect(headroom.fitsCurrentRequest).toBe(true);
    expect(headroom.remainingTokens).toBe(22_616);
    expect(headroom.needsPreparation).toBe(false);

    const tight = computeRequestHeadroom({
      windowTokens: 200_000,
      fullInputTokens: 170_000,
      outputAllowanceTokens: 16_384,
      safetyTokens: 1_000,
      expectedGrowthTokens: 16_384,
    });
    expect(tight.remainingTokens).toBe(12_616);
    expect(tight.needsPreparation).toBe(true);
  });

  it("treats a request that does not fit as needing preparation", () => {
    const headroom = computeRequestHeadroom({
      windowTokens: 10_000,
      fullInputTokens: 9_500,
      outputAllowanceTokens: 2_048,
      safetyTokens: 512,
      expectedGrowthTokens: 1_024,
    });
    expect(headroom.fitsCurrentRequest).toBe(false);
    expect(headroom.needsPreparation).toBe(true);
  });
});

describe("HEADROOM_V1 Context policy thresholds", () => {
  const modelDescriptor = model(MEGA_WINDOW, 65_536);

  it("derives both thresholds from the allowance and the growth, not from a fixed target", () => {
    const policy = createContextPolicy({
      model: modelDescriptor,
      options: {
        outputReserveTokens: 16_384,
        safetyReserveTokens: 4_096,
        requestHeadroom: { expectedGrowthTokens: 16_384, postCompactionRatio: 0.8 },
      },
    });
    const overhead = policy.requestOverhead.totalTokens;
    const effectiveInputLimit = MEGA_WINDOW - 16_384 - 4_096 - overhead;
    expect(policy.effectiveInputLimitTokens).toBe(effectiveInputLimit);
    expect(policy.proactiveCompactionTokens).toBe(effectiveInputLimit - 16_384);
    // The emergency band is the real boundary, not 90% of it.
    expect(policy.emergencyCompactionTokens).toBe(effectiveInputLimit);
    expect(policy.proactiveCompactionTokens).toBeLessThan(policy.emergencyCompactionTokens);
    // No working set survives into a headroom policy.
    expect(policy.workingSet).toBeUndefined();
    expect(policy.requestHeadroom?.expectedGrowthTokens).toBe(16_384);
  });

  it("keeps a 1M-window Run with 8% input far below both thresholds", () => {
    const policy = createContextPolicy({
      model: modelDescriptor,
      options: {
        outputReserveTokens: 16_384,
        safetyReserveTokens: 4_096,
        requestHeadroom: { expectedGrowthTokens: 16_384, postCompactionRatio: 0.8 },
      },
    });
    const eightPercent = Math.floor(MEGA_WINDOW * 0.08);
    expect(eightPercent).toBeLessThan(policy.proactiveCompactionTokens);
    expect(policy.proactiveCompactionTokens).toBeGreaterThan(900_000);
  });
});

describe("TURN_BUDGET_DECISION_V1", () => {
  it("records the same allowance it used and satisfies its own constraint", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
    });
    const decision = decideTurnBudget({
      policy,
      modelProfileRef: "test/headroom",
      preparedSurfaceDigest: "sha256:" + "a".repeat(64),
      windowTokens: MEGA_WINDOW,
      fullInputTokens: 90_000,
      outputAllowanceTokens: 16_384,
      compacted: false,
    });
    expect(decision.decision).toBe("KEEP");
    expect(decision.remainingTokens).toBe(MEGA_WINDOW - 90_000 - 16_384 - 4_096);
    expect(decision.sources.output).toBe("PREFERRED_ALLOWANCE");
  });

  it("reports ADJUST_OUTPUT when the allowance had to shrink", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: MEGA_WINDOW,
      maxOutputTokens: 65_536,
    });
    const decision = decideTurnBudget({
      policy,
      modelProfileRef: "test/headroom",
      preparedSurfaceDigest: "sha256:" + "b".repeat(64),
      windowTokens: MEGA_WINDOW,
      fullInputTokens: 980_000,
      outputAllowanceTokens: 4_096,
      compacted: false,
    });
    expect(decision.decision).toBe("ADJUST_OUTPUT");
    expect(decision.sources.output).toBe("AVAILABLE_ROOM");
  });

  it("reports PREPARE_HISTORY only when the growth no longer fits", () => {
    const policy = resolveTurnBudgetPolicy({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    });
    const decision = decideTurnBudget({
      policy,
      modelProfileRef: "test/headroom",
      preparedSurfaceDigest: "sha256:" + "c".repeat(64),
      windowTokens: 200_000,
      fullInputTokens: 195_000,
      outputAllowanceTokens: 2_048,
      compacted: false,
    });
    expect(decision.decision).toBe("PREPARE_HISTORY");
    expect(decision.remainingTokens).toBeLessThan(policy.expectedGrowthTokens);
  });
});
