import { describe, expect, it } from "vitest";

import {
  createContextRecoveryPlanner,
  type ContextPolicy,
  type ContextPressureEvaluation,
} from "@caelush/agent";

const policy = {
  effectiveInputLimitTokens: 10_000,
  targetRecentTailTokens: 3_500,
  minRecentTailTokens: 1_500,
} as ContextPolicy;

const pressure = (shouldCompact: boolean): ContextPressureEvaluation => ({
  state: shouldCompact ? "PROACTIVE" : "NORMAL",
  trigger: shouldCompact ? "PROACTIVE_PRESSURE" : "NONE",
  pressureRatio: shouldCompact ? 0.8 : 0.2,
  shouldCompact,
  targetPostCompactionTokens: 2_800,
  targetRecentTailTokens: policy.targetRecentTailTokens,
  minRecentTailTokens: policy.minRecentTailTokens,
});

describe("Phase 8E ContextRecoveryPlanner", () => {
  it("keeps NORMAL recovery bounded to no action or one compaction action", () => {
    const planner = createContextRecoveryPlanner();

    expect(
      planner.plan({
        mode: "NORMAL",
        pressure: pressure(false),
        policy,
        hasCompressibleHistory: true,
      }),
    ).toEqual({
      stage: "NORMAL",
      actions: [],
      targetRecentTailTokens: 3_500,
      minRecentTailTokens: 1_500,
    });

    expect(
      planner.plan({
        mode: "NORMAL",
        pressure: pressure(true),
        policy,
        hasCompressibleHistory: true,
      }).actions,
    ).toEqual(["COMPACT_HISTORY"]);
  });

  it("returns the fixed FORCED action order with a smaller bounded tail", () => {
    const planner = createContextRecoveryPlanner();

    expect(
      planner.plan({
        mode: "FORCED_RECOVERY",
        pressure: pressure(true),
        policy,
        hasCompressibleHistory: true,
      }),
    ).toEqual({
      stage: "FORCED",
      actions: [
        "DEFER_LOW_RETRIEVABLE",
        "REDUCE_OPTIONAL_SOURCES",
        "COMPACT_HISTORY",
        "TIGHTEN_RECENT_TAIL",
        "EXHAUSTED",
      ],
      targetRecentTailTokens: 1_200,
      minRecentTailTokens: 500,
    });
  });
});
