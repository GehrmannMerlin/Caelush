import { describe, expect, it } from "vitest";

import type { ResourceProgressPatternRecord, ResourceProgressTurnRecord } from "@caelush/protocol";

import {
  acknowledgeResourceReplan,
  acknowledgeV1ResourceNudge,
  applyResourceProgressTurn,
  decideResourceSemanticIntervention,
  emptyResourceSemanticProgress,
  recordResourceNudgeDelivery,
  resourceProgressPolicyFrom,
  resourceSemanticSummary,
  RESOURCE_PROGRESS_WINDOW_TURNS,
  type ResourceProgressPolicy,
  type ResourceSemanticProgress,
} from "../src/resource-progress-projection.js";

/**
 * The repeated-failure window and the two correction disciplines.
 *
 * ```text
 * V1  detected   3 occurrences          NUDGE   - say what is wrong, allow the correction
 *     detected   4 occurrences          REPLAN  - close the batch unexecuted, ask for another approach
 *     after two re-plans                WAITING - a human decides what happens next
 *
 * V2  detected   3 occurrences          NUDGE INPUT_CORRECTION   and the batch still runs
 *     delivered  1 correction           NUDGE REVIEW_APPROACH    and the batch still runs
 *     delivered  2 corrections          NUDGE REBUILD_WORK_STATE and the batch still runs
 *     delivered  3 corrections          NONE — the ladder is spent, the Window ends the episode
 * ```
 *
 * Both are pure functions of accepted turns, so the same evidence always produces the same decision
 * and no clock can become the reason a Run stops.
 *
 * The V2 rows are the ones that matter for the incident: the Run's *batches* are never refused on
 * cumulative history, so a call that has just been corrected is admitted and executes. V1 rows are the
 * historical contract and are asserted separately so a V2 change cannot silently rewrite them.
 */

const PATTERN: ResourceProgressPatternRecord = Object.freeze({
  key: "a".repeat(64),
  toolName: "apply_patch",
  code: "TOOL_ARGUMENT_ERROR",
  fields: Object.freeze([Object.freeze({ keyword: "required", name: "patch" })]),
});

const V1: ResourceProgressPolicy = Object.freeze({
  windowTurns: 8,
  nudgeAfterOccurrences: 3,
  reviewAfterOccurrences: 4,
  replanAfterOccurrences: 4,
  replansBeforePause: 2,
  correctionVersion: "V1" as const,
});

const V2: ResourceProgressPolicy = Object.freeze({ ...V1, correctionVersion: "V2" as const });

function turn(
  id: string,
  options: {
    readonly pattern?: ResourceProgressPatternRecord | "none";
    readonly success?: readonly string[];
  } = {},
): ResourceProgressTurnRecord {
  return Object.freeze({
    turnId: id,
    patterns: options.pattern === "none" ? Object.freeze([]) : Object.freeze([PATTERN]),
    succeededTools: Object.freeze([...(options.success ?? [])]),
    classified: true,
  });
}

function fold(
  turns: readonly ResourceProgressTurnRecord[],
  policy: ResourceProgressPolicy = V1,
): ResourceSemanticProgress {
  return turns.reduce(
    (state, value) => applyResourceProgressTurn(policy, state, value),
    emptyResourceSemanticProgress(),
  );
}

describe("resource progress window (V1 discipline)", () => {
  it("reminds after three occurrences and then stops repeating itself", () => {
    const afterTwo = fold([turn("s1"), turn("s2")]);
    expect(decideResourceSemanticIntervention(V1, afterTwo).kind).toBe("NONE");

    const afterThree = fold([turn("s1"), turn("s2"), turn("s3")]);
    const decision = decideResourceSemanticIntervention(V1, afterThree);
    expect(decision).toMatchObject({ kind: "NUDGE", toolName: "apply_patch", occurrences: 3 });

    const acknowledged = acknowledgeV1ResourceNudge(afterThree);
    expect(decideResourceSemanticIntervention(V1, acknowledged).kind).toBe("NONE");
  });

  it("requires a re-plan on the fourth occurrence and starts a fresh episode afterwards", () => {
    const afterFour = fold([turn("s1"), turn("s2"), turn("s3"), turn("s4")]);
    expect(decideResourceSemanticIntervention(V1, afterFour)).toMatchObject({
      kind: "REPLAN",
      occurrences: 4,
    });

    const replanned = acknowledgeResourceReplan(afterFour, "s4");
    expect(replanned.active?.replans).toBe(1);
    // The same four turns are still in the window but no longer count toward the new episode.
    expect(decideResourceSemanticIntervention(V1, replanned).kind).toBe("NONE");

    const afterNextThree = ["s5", "s6", "s7"].reduce(
      (state, id) => applyResourceProgressTurn(V1, state, turn(id)),
      replanned,
    );
    expect(decideResourceSemanticIntervention(V1, afterNextThree).kind).toBe("NUDGE");
  });

  it("waits for a human only after two re-plans of the same pattern", () => {
    let state = fold([turn("s1"), turn("s2"), turn("s3"), turn("s4")]);
    expect(decideResourceSemanticIntervention(V1, state).kind).toBe("REPLAN");

    state = acknowledgeResourceReplan(state, "s4");
    state = ["s5", "s6", "s7", "s8"].reduce(
      (value, id) => applyResourceProgressTurn(V1, value, turn(id)),
      state,
    );
    expect(decideResourceSemanticIntervention(V1, state).kind).toBe("REPLAN");

    state = acknowledgeResourceReplan(state, "s8");
    state = ["s9", "s10", "s11", "s12"].reduce(
      (value, id) => applyResourceProgressTurn(V1, value, turn(id)),
      state,
    );
    expect(decideResourceSemanticIntervention(V1, state)).toMatchObject({
      kind: "WAITING_RESOURCE",
      occurrences: 4,
    });
  });
});

describe("resource progress window (V2 autonomous correction)", () => {
  it("never produces a re-plan or a wait, however long the pattern repeats", () => {
    let state = fold([], V2);
    for (let index = 0; index < 24; index += 1) {
      state = applyResourceProgressTurn(V2, state, turn(`v2-${String(index)}`));
      const decision = decideResourceSemanticIntervention(V2, state);
      expect(decision.kind).not.toBe("REPLAN");
      expect(decision.kind).not.toBe("WAITING_RESOURCE");
    }
  });

  it("escalates with each delivered correction and stops after the last rung", () => {
    let state = fold([turn("a1"), turn("a2"), turn("a3")], V2);
    expect(decideResourceSemanticIntervention(V2, state)).toMatchObject({
      kind: "NUDGE",
      stage: "INPUT_CORRECTION",
      deliveredInterventions: 0,
    });

    state = recordResourceNudgeDelivery(state);
    expect(decideResourceSemanticIntervention(V2, state)).toMatchObject({
      kind: "NUDGE",
      stage: "REVIEW_APPROACH",
      deliveredInterventions: 1,
    });

    // The third rung is only offered once the episode has the evidence its text describes.
    state = applyResourceProgressTurn(V2, state, turn("a4"));
    state = recordResourceNudgeDelivery(state);
    expect(decideResourceSemanticIntervention(V2, state)).toMatchObject({
      kind: "NUDGE",
      stage: "REBUILD_WORK_STATE",
      deliveredInterventions: 2,
    });

    state = recordResourceNudgeDelivery(state);
    expect(decideResourceSemanticIntervention(V2, state).kind).toBe("NONE");
  });

  it("does not advance the ladder for a correction that was only detected", () => {
    const detected = fold([turn("b1"), turn("b2"), turn("b3")], V2);
    const again = decideResourceSemanticIntervention(V2, detected);
    // Same detection, no delivery in between: the same rung is offered again rather than skipped.
    expect(again).toMatchObject({ kind: "NUDGE", stage: "INPUT_CORRECTION" });
    expect(detected.active?.deliveredInterventions).toBe(0);
  });

  it("retires a pending correction only for the identity that was delivered", () => {
    const withCorrection: ResourceSemanticProgress = Object.freeze({
      ...fold([turn("c1"), turn("c2"), turn("c3")], V2),
      correction: Object.freeze({
        interventionId: "new",
        stage: "INPUT_CORRECTION" as const,
        patternKey: PATTERN.key,
        toolName: PATTERN.toolName,
        code: PATTERN.code,
        occurrences: 3,
        guidance: "fields",
        sourceStepId: "step-1",
      }),
    });
    const staleReceipt = recordResourceNudgeDelivery(withCorrection, "old");
    expect(staleReceipt).toBe(withCorrection);
    expect(staleReceipt.correction?.interventionId).toBe("new");

    const fresh = recordResourceNudgeDelivery(withCorrection, "new");
    expect(fresh.correction).toBeUndefined();
    expect(fresh.active?.deliveredInterventions).toBe(1);
  });

  it("keeps a pending correction across a window fold", () => {
    const base = fold([turn("d1"), turn("d2"), turn("d3")], V2);
    const withCorrection = Object.freeze({
      ...base,
      correction: Object.freeze({
        interventionId: "keep",
        stage: "INPUT_CORRECTION" as const,
        patternKey: PATTERN.key,
        toolName: PATTERN.toolName,
        code: PATTERN.code,
        occurrences: 3,
        guidance: "fields",
        sourceStepId: "step-1",
      }),
    });
    const folded = applyResourceProgressTurn(V2, withCorrection, turn("d4"));
    expect(folded.correction?.interventionId).toBe("keep");
  });
});

describe("resource progress window (shared)", () => {
  it("resolves the episode when the same Tool finally runs successfully", () => {
    const state = [
      turn("s1"),
      turn("s2"),
      turn("s3"),
      turn("s4", { pattern: "none", success: ["apply_patch"] }),
    ].reduce(
      (value, item) => applyResourceProgressTurn(V1, value, item),
      emptyResourceSemanticProgress(),
    );

    expect(state.active).toBeUndefined();
    expect(decideResourceSemanticIntervention(V1, state).kind).toBe("NONE");
  });

  it("forgets a pattern that has fallen out of the window", () => {
    const turns = [
      turn("s1"),
      turn("s2"),
      turn("s3"),
      ...Array.from({ length: RESOURCE_PROGRESS_WINDOW_TURNS }, (_unused, index) =>
        turn(`quiet-${String(index)}`, { pattern: "none" }),
      ),
    ];
    const state = fold(turns);
    expect(state.turns).toHaveLength(RESOURCE_PROGRESS_WINDOW_TURNS);
    expect(state.active).toBeUndefined();
  });

  it("does not count a repeated post-commit update twice", () => {
    const once = applyResourceProgressTurn(V1, emptyResourceSemanticProgress(), turn("s1"));
    const twice = applyResourceProgressTurn(V1, once, turn("s1"));
    expect(twice).toBe(once);
    expect(twice.turns).toHaveLength(1);
  });

  it("never escalates on ordinary activity", () => {
    const state = Array.from({ length: 12 }, (_unused, index) =>
      turn(`a${String(index)}`, { pattern: "none", success: ["read_file", "apply_patch"] }),
    ).reduce(
      (value, item) => applyResourceProgressTurn(V1, value, item),
      emptyResourceSemanticProgress(),
    );
    expect(decideResourceSemanticIntervention(V1, state).kind).toBe("NONE");
    expect(resourceSemanticSummary(state)).toEqual({
      occurrences: 0,
      replans: 0,
      deliveredInterventions: 0,
    });
  });

  it("reports the active pattern for a checkpoint without exposing the window", () => {
    const state = fold([turn("s1"), turn("s2"), turn("s3")]);
    expect(resourceSemanticSummary(state)).toMatchObject({
      activePatternKey: PATTERN.key,
      toolName: "apply_patch",
      code: "TOOL_ARGUMENT_ERROR",
      occurrences: 3,
      replans: 0,
    });
  });
});

describe("resource progress policy", () => {
  it("reads every threshold from the Run's frozen policy", () => {
    const policy = resourceProgressPolicyFrom({
      mode: "ADAPTIVE",
      correctionVersion: "AUTONOMOUS_CORRECTION_V2",
      operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
      batch: { maxToolCallsPerTurn: 16 },
      progress: {
        windowTurns: 5,
        identicalCallNudgeThreshold: 2,
        noProgressTurnsBeforeReplan: 3,
        replansBeforePause: 9,
      },
      hardLimits: {},
      inactivity: {},
    });
    expect(policy).toMatchObject({
      windowTurns: 5,
      nudgeAfterOccurrences: 2,
      reviewAfterOccurrences: 3,
      replansBeforePause: 9,
      correctionVersion: "V2",
    });
  });

  it("treats a policy without a correction version as historical V1", () => {
    expect(
      resourceProgressPolicyFrom({
        mode: "ADAPTIVE",
        operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 8,
          identicalCallNudgeThreshold: 3,
          noProgressTurnsBeforeReplan: 4,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      }).correctionVersion,
    ).toBe("V1");
  });

  it("honours a configured window rather than the historical constant", () => {
    const narrow: ResourceProgressPolicy = Object.freeze({ ...V1, windowTurns: 3 });
    const fold = (items: readonly ResourceProgressTurnRecord[]) =>
      items.reduce(
        (value, item) => applyResourceProgressTurn(narrow, value, item),
        emptyResourceSemanticProgress(),
      );
    // One quiet turn is not enough: the pattern is still inside a three-turn window.
    const withOneQuiet = fold([
      turn("w1"),
      turn("w2"),
      turn("w3"),
      turn("w4", { pattern: "none" }),
    ]);
    expect(withOneQuiet.turns).toHaveLength(3);
    expect(withOneQuiet.active).toBeDefined();

    // Once the pattern itself has left the window the episode ends, which is what "forgotten because
    // it stopped happening" means — not "forgotten because a fixed number of turns elapsed".
    const withTwoQuiet = fold([
      turn("w1"),
      turn("w2"),
      turn("w3"),
      turn("w4", { pattern: "none" }),
      turn("w5", { pattern: "none" }),
      turn("w6", { pattern: "none" }),
    ]);
    expect(withTwoQuiet.turns).toHaveLength(3);
    expect(withTwoQuiet.active).toBeUndefined();
  });
});
