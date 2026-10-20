import { describe, expect, it } from "vitest";

import type { ResourceProgressPatternRecord, ResourceProgressTurnRecord } from "@caelush/protocol";

import {
  acknowledgeResourceNudge,
  acknowledgeResourceReplan,
  applyResourceProgressTurn,
  decideResourceSemanticIntervention,
  emptyResourceSemanticProgress,
  resourceSemanticSummary,
  RESOURCE_PROGRESS_WINDOW_TURNS,
  type ResourceSemanticProgress,
} from "../src/resource-progress-projection.js";

/**
 * The repeated-failure window and the intervention ladder.
 *
 * ```text
 * 3 occurrences in the window   NUDGE   - say what is wrong, allow the correction
 * 4 occurrences in the episode  REPLAN  - do not run this batch, ask for another approach
 * after two re-plans            WAITING - a human decides
 * a later success               resolved
 * ```
 *
 * Every rule is a pure function of accepted turns, so the same evidence always produces the same
 * decision and no clock can become the reason a Run stops.
 */

const PATTERN: ResourceProgressPatternRecord = Object.freeze({
  key: "a".repeat(64),
  toolName: "apply_patch",
  code: "TOOL_ARGUMENT_ERROR",
  fields: Object.freeze([Object.freeze({ keyword: "required", name: "patch" })]),
});

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

function fold(turns: readonly ResourceProgressTurnRecord[]): ResourceSemanticProgress {
  return turns.reduce(applyResourceProgressTurn, emptyResourceSemanticProgress());
}

describe("resource progress window", () => {
  it("reminds after three occurrences and then stops repeating itself", () => {
    const afterTwo = fold([turn("s1"), turn("s2")]);
    expect(decideResourceSemanticIntervention(afterTwo).kind).toBe("NONE");

    const afterThree = fold([turn("s1"), turn("s2"), turn("s3")]);
    const decision = decideResourceSemanticIntervention(afterThree);
    expect(decision).toMatchObject({ kind: "NUDGE", toolName: "apply_patch", occurrences: 3 });

    const acknowledged = acknowledgeResourceNudge(afterThree);
    expect(decideResourceSemanticIntervention(acknowledged).kind).toBe("NONE");
  });

  it("requires a re-plan on the fourth occurrence and starts a fresh episode afterwards", () => {
    const afterFour = fold([turn("s1"), turn("s2"), turn("s3"), turn("s4")]);
    expect(decideResourceSemanticIntervention(afterFour)).toMatchObject({
      kind: "REPLAN",
      occurrences: 4,
    });

    const replanned = acknowledgeResourceReplan(afterFour, "s4");
    expect(replanned.active?.replans).toBe(1);
    // The same four turns are still in the window but no longer count toward the new episode.
    expect(decideResourceSemanticIntervention(replanned).kind).toBe("NONE");

    const afterNextThree = [replanned]
      .map((value) => value)
      .reduce(
        (state, value) =>
          [turn("s5"), turn("s6"), turn("s7")].reduce(applyResourceProgressTurn, value),
        replanned,
      );
    expect(decideResourceSemanticIntervention(afterNextThree).kind).toBe("NUDGE");
  });

  it("waits for a human only after two re-plans of the same pattern", () => {
    let state = fold([turn("s1"), turn("s2"), turn("s3"), turn("s4")]);
    expect(decideResourceSemanticIntervention(state).kind).toBe("REPLAN");

    state = acknowledgeResourceReplan(state, "s4");
    state = ["s5", "s6", "s7", "s8"].reduce(
      (value, id) => applyResourceProgressTurn(value, turn(id)),
      state,
    );
    expect(decideResourceSemanticIntervention(state).kind).toBe("REPLAN");

    state = acknowledgeResourceReplan(state, "s8");
    state = ["s9", "s10", "s11", "s12"].reduce(
      (value, id) => applyResourceProgressTurn(value, turn(id)),
      state,
    );
    expect(decideResourceSemanticIntervention(state)).toMatchObject({
      kind: "WAITING_RESOURCE",
      occurrences: 4,
    });
  });

  it("resolves the episode when the same Tool finally runs successfully", () => {
    const state = [
      turn("s1"),
      turn("s2"),
      turn("s3"),
      turn("s4", { pattern: "none", success: ["apply_patch"] }),
    ].reduce(applyResourceProgressTurn, emptyResourceSemanticProgress());

    expect(state.active).toBeUndefined();
    expect(decideResourceSemanticIntervention(state).kind).toBe("NONE");
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
    const once = applyResourceProgressTurn(emptyResourceSemanticProgress(), turn("s1"));
    const twice = applyResourceProgressTurn(once, turn("s1"));
    expect(twice).toBe(once);
    expect(twice.turns).toHaveLength(1);
  });

  it("never escalates on ordinary activity", () => {
    const state = Array.from({ length: 12 }, (_unused, index) =>
      turn(`a${String(index)}`, { pattern: "none", success: ["read_file", "apply_patch"] }),
    ).reduce(applyResourceProgressTurn, emptyResourceSemanticProgress());
    expect(decideResourceSemanticIntervention(state).kind).toBe("NONE");
    expect(resourceSemanticSummary(state)).toEqual({ occurrences: 0, replans: 0 });
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
