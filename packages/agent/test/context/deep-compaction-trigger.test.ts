import { describe, expect, it } from "vitest";

import { createContextPressureEvaluator } from "../../src/context/compaction/context-pressure-evaluator.js";

/**
 * The proactive compaction ladder.
 *
 * The defect these pin: `PROACTIVE` was a label. At 75% pressure nothing compacted, so a long Run
 * only summarised once it was already at the input limit — or never, as the two failed Runs did.
 */

const LIMIT = 100_000;

function pressure(ratio: number, triggerRatio = 0.9) {
  return createContextPressureEvaluator().evaluate({
    estimatedInputTokens: Math.round(LIMIT * ratio),
    selectedPlanningTokens: 100,
    mandatoryTokens: 10,
    historySelectionPressure: false,
    effectiveInputLimitTokens: LIMIT,
    proactiveCompactionTokens: Math.round(LIMIT * triggerRatio),
    emergencyCompactionTokens: LIMIT,
    targetRecentTailTokens: 20_000,
    minRecentTailTokens: 8_000,
    mode: "NORMAL",
    hasCompressibleHistory: true,
    proactive: { enabled: true },
  });
}

describe("deep-compaction trigger", () => {
  it("keeps using the full window until its configured trigger is reached", () => {
    expect(pressure(0.899).shouldCompact).toBe(false);
    expect(pressure(0.9).shouldCompact).toBe(true);
    expect(pressure(0.94).shouldCompact).toBe(true);
  });

  it("does not add a rearm threshold or turn-count lockout after each success", () => {
    const afterFirstCompaction = pressure(0.89);
    expect(afterFirstCompaction.shouldCompact).toBe(false);
    // As soon as real input growth crosses the trigger again, another attempt is allowed.
    expect(pressure(0.9).shouldCompact).toBe(true);
  });

  it("respects a frozen historical threshold when one was explicitly supplied", () => {
    expect(pressure(0.76, 0.75).shouldCompact).toBe(true);
    expect(pressure(0.74, 0.75).shouldCompact).toBe(false);
  });
});
