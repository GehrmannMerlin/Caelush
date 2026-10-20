import { describe, expect, it } from "vitest";

import {
  advanceContextCompactionSchedule,
  contextCompactionDue,
  DEFAULT_CONTEXT_COMPACTION_SCHEDULE_POLICY,
  initialContextCompactionSchedule,
  type ContextCompactionSchedule,
} from "../../src/context/compaction/context-compaction-schedule.js";
import { createContextPressureEvaluator } from "../../src/context/compaction/context-pressure-evaluator.js";

/**
 * The proactive compaction ladder.
 *
 * The defect these pin: `PROACTIVE` was a label. At 75% pressure nothing compacted, so a long Run
 * only summarised once it was already at the input limit — or never, as the two failed Runs did.
 */

const LIMIT = 100_000;

function pressure(ratio: number, proactive?: { armed: boolean; cooldown: number }) {
  return createContextPressureEvaluator().evaluate({
    estimatedInputTokens: Math.round(LIMIT * ratio),
    selectedPlanningTokens: 100,
    mandatoryTokens: 10,
    historySelectionPressure: false,
    effectiveInputLimitTokens: LIMIT,
    proactiveCompactionTokens: Math.round(LIMIT * 0.75),
    emergencyCompactionTokens: Math.round(LIMIT * 0.9),
    targetRecentTailTokens: 20_000,
    minRecentTailTokens: 8_000,
    mode: "NORMAL",
    hasCompressibleHistory: true,
    ...(proactive === undefined
      ? {}
      : {
          proactive: {
            enabled: true,
            armed: proactive.armed,
            cooldownTurnsRemaining: proactive.cooldown,
            emergency: ratio >= 0.9,
          },
        }),
  });
}

describe("proactive compaction pressure", () => {
  it("keeps the legacy behaviour when the Run did not opt in", () => {
    expect(pressure(0.76).shouldCompact).toBe(false);
    expect(pressure(0.76).trigger).toBe("PROACTIVE_PRESSURE");
    // The label was always reported; only acting on it is new.
    expect(pressure(1).shouldCompact).toBe(true);
  });

  it("actually compacts inside the proactive band when armed", () => {
    expect(pressure(0.76, { armed: true, cooldown: 0 }).shouldCompact).toBe(true);
    expect(pressure(0.74, { armed: true, cooldown: 0 }).shouldCompact).toBe(false);
  });

  it("honours the cooldown and the hysteresis", () => {
    expect(pressure(0.76, { armed: true, cooldown: 2 }).shouldCompact).toBe(false);
    expect(pressure(0.76, { armed: false, cooldown: 0 }).shouldCompact).toBe(false);
    // Emergency pressure bypasses both, because the window is already failing.
    expect(pressure(0.95, { armed: false, cooldown: 9 }).shouldCompact).toBe(true);
  });
});

describe("compaction schedule", () => {
  const advance = (
    state: ContextCompactionSchedule,
    ratio: number,
    overrides: { emergency?: boolean; forced?: boolean; compacted?: boolean } = {},
  ) =>
    advanceContextCompactionSchedule(state, {
      pressureRatio: ratio,
      emergency: overrides.emergency ?? false,
      forced: overrides.forced ?? false,
      compacted: overrides.compacted ?? false,
    });

  it("starts armed and disarms a turn that attempted compaction", () => {
    const initial = initialContextCompactionSchedule();
    expect(initial).toEqual({ armed: true, cooldownTurnsRemaining: 0 });

    const afterAttempt = advance(initial, 0.76, { compacted: true });
    expect(afterAttempt).toEqual({
      armed: false,
      cooldownTurnsRemaining: DEFAULT_CONTEXT_COMPACTION_SCHEDULE_POLICY.cooldownTurns,
    });
    expect(
      contextCompactionDue(afterAttempt, { enabled: true, emergency: false, forced: false }),
    ).toBe(false);
  });

  it("counts the cooldown down one turn at a time", () => {
    let state = advance(initialContextCompactionSchedule(), 0.76, { compacted: true });
    for (let turn = 1; turn <= 3; turn += 1) {
      state = advance(state, 0.78);
      expect(state.cooldownTurnsRemaining).toBe(4 - turn);
      expect(contextCompactionDue(state, { enabled: true, emergency: false, forced: false })).toBe(
        false,
      );
    }
    state = advance(state, 0.78);
    expect(state.cooldownTurnsRemaining).toBe(0);
  });

  it("re-arms only after pressure falls back below the rearm ratio", () => {
    let state = advance(initialContextCompactionSchedule(), 0.76, { compacted: true });
    state = advance(state, 0.7);
    state = advance(state, 0.7);
    state = advance(state, 0.7);
    state = advance(state, 0.7);
    expect(state.cooldownTurnsRemaining).toBe(0);
    // Still disarmed: the Run is hovering above the rearm ratio, so it must not summarise every turn.
    expect(state.armed).toBe(false);

    state = advance(state, 0.6);
    expect(state.armed).toBe(true);
  });

  it("lets emergency and forced recovery through the pacing", () => {
    const disarmed = advance(initialContextCompactionSchedule(), 0.76, { compacted: true });
    expect(contextCompactionDue(disarmed, { enabled: true, emergency: true, forced: false })).toBe(
      true,
    );
    expect(contextCompactionDue(disarmed, { enabled: true, emergency: false, forced: true })).toBe(
      true,
    );
    expect(advance(disarmed, 0.95, { emergency: true }).armed).toBe(true);
  });

  it("does nothing at all when the policy is disabled", () => {
    const armed = initialContextCompactionSchedule();
    expect(contextCompactionDue(armed, { enabled: false, emergency: true, forced: true })).toBe(
      false,
    );
  });

  it("is deterministic for the same turn inputs", () => {
    const start = initialContextCompactionSchedule();
    expect(advance(start, 0.8)).toEqual(advance(start, 0.8));
  });
});
