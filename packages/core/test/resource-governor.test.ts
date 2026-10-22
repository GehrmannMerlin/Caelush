import { describe, expect, it } from "vitest";
import { ResourceGovernor } from "../src/resource-governor.js";

/**
 * The Tool-batch resource authority.
 *
 * Two disciplines, one governor:
 *
 * ```text
 * V1  repeated no-progress can end in WAIT_FOR_RESOURCE_DECISION after `replansBeforePause` re-plans
 * V2  repeated no-progress is advice; the batch in front of the Run is admitted on its own merits
 * ```
 *
 * And two accountings that must never be substituted for one another:
 *
 * ```text
 * cumulativeAgentTurns / cumulativeToolOperations   the whole Run — hard budgets
 * turnsInLease / toolsInLease                       this lease epoch — renewal
 * ```
 */

const basePolicy = {
  mode: "ADAPTIVE" as const,
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
};

const v1 = { ...basePolicy };
const v2 = { ...basePolicy, correctionVersion: "AUTONOMOUS_CORRECTION_V2" as const };

function evaluate(
  policy: typeof basePolicy | typeof v2,
  input: {
    readonly cumulativeAgentTurns: number;
    readonly cumulativeToolOperations: number;
    readonly turnsInLease: number;
    readonly toolsInLease: number;
    readonly requestedToolCalls: number;
    readonly progressLevel: "HEALTHY" | "NUDGE" | "FORCED_REPLAN" | "WAITING_RESOURCE";
    readonly replanCount: number;
  },
) {
  return new ResourceGovernor(policy as never).evaluateToolBatch(input);
}

describe("ResourceGovernor", () => {
  it("renews a healthy operational lease instead of terminally rejecting the batch", () => {
    expect(
      evaluate(v1, {
        cumulativeAgentTurns: 24,
        cumulativeToolOperations: 63,
        turnsInLease: 24,
        toolsInLease: 63,
        requestedToolCalls: 5,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toEqual({ kind: "RENEW_AND_ALLOW", nextLeaseEpoch: 2 });
  });

  it("measures the lease by this epoch and the hard budget by the whole Run", () => {
    // The Run has been going for a long time, but this lease is brand new. Comparing the lease
    // threshold against the cumulative turn count is what renewed a lease on every single batch.
    expect(
      evaluate(v1, {
        cumulativeAgentTurns: 75,
        cumulativeToolOperations: 300,
        turnsInLease: 0,
        toolsInLease: 0,
        requestedToolCalls: 4,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }).kind,
    ).toBe("ALLOW");

    // A lease that has genuinely reached its turn budget renews exactly once.
    expect(
      evaluate(v1, {
        cumulativeAgentTurns: 75,
        cumulativeToolOperations: 300,
        turnsInLease: 24,
        toolsInLease: 10,
        requestedToolCalls: 1,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toMatchObject({ kind: "RENEW_AND_ALLOW", nextLeaseEpoch: 2 });
  });

  it("keeps the per-turn batch bound separate from lifetime operations", () => {
    const result = evaluate(v1, {
      cumulativeAgentTurns: 2,
      cumulativeToolOperations: 200,
      turnsInLease: 2,
      toolsInLease: 12,
      requestedToolCalls: 17,
      progressLevel: "HEALTHY",
      replanCount: 0,
    });

    expect(result.kind).toBe("REPLAN");
    if (result.kind === "REPLAN") expect(result.requestedToolCalls).toBe(17);
  });

  it("enforces explicit hard Tool ceilings", () => {
    expect(
      new ResourceGovernor({ ...basePolicy, hardLimits: { maxToolCalls: 8 } }).evaluateToolBatch({
        cumulativeAgentTurns: 4,
        cumulativeToolOperations: 4,
        turnsInLease: 4,
        toolsInLease: 4,
        requestedToolCalls: 5,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toMatchObject({ kind: "HARD_STOP", dimension: "TOOL_CALLS", limit: 8 });
  });

  it("pauses repeated no-progress only under the V1 discipline", () => {
    expect(
      evaluate(v1, {
        cumulativeAgentTurns: 4,
        cumulativeToolOperations: 100,
        turnsInLease: 4,
        toolsInLease: 20,
        requestedToolCalls: 1,
        progressLevel: "FORCED_REPLAN",
        replanCount: 2,
      }),
    ).toMatchObject({ kind: "WAIT_FOR_RESOURCE_DECISION" });
  });

  it("admits a V2 batch that follows two historical re-plans", () => {
    // The incident: two earlier re-plans had been recorded, then the model corrected its call. Under
    // V1 the corrected call was refused before preparation; under V2 it is admitted and the advice
    // travels with the next request instead.
    const decision = evaluate(v2, {
      cumulativeAgentTurns: 4,
      cumulativeToolOperations: 100,
      turnsInLease: 4,
      toolsInLease: 20,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 2,
    });
    expect(decision).toMatchObject({ kind: "ALLOW_WITH_NUDGE" });
    expect(decision).not.toMatchObject({ kind: "WAIT_FOR_RESOURCE_DECISION" });
  });

  it("admits and advises rather than waiting when V2 is handed a wait level", () => {
    const decision = evaluate(v2, {
      cumulativeAgentTurns: 4,
      cumulativeToolOperations: 100,
      turnsInLease: 4,
      toolsInLease: 20,
      requestedToolCalls: 1,
      progressLevel: "WAITING_RESOURCE",
      replanCount: 5,
    });
    expect(decision.kind).toBe("ALLOW_WITH_NUDGE");
  });

  it("carries the correction stage and guidance it was given", () => {
    const decision = evaluate(v2, {
      cumulativeAgentTurns: 4,
      cumulativeToolOperations: 10,
      turnsInLease: 4,
      toolsInLease: 2,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 0,
    });
    // No specific guidance supplied: the generic re-plan text is used, never an empty string.
    expect(decision.kind).toBe("ALLOW_WITH_NUDGE");
    if (decision.kind === "ALLOW_WITH_NUDGE") {
      expect(decision.guidance.length).toBeGreaterThan(0);
      expect(decision.stage).toBeUndefined();
    }
  });

  it("admits an oversized batch under V2, because the size is a chunk size", () => {
    // Q06: the batch limit is an execution chunk size, not an admission line. The coordinator splits
    // the calls and the model still receives one result per call, so refusing here would be the
    // defect this test used to lock in.
    expect(
      evaluate(v2, {
        cumulativeAgentTurns: 1,
        cumulativeToolOperations: 0,
        turnsInLease: 1,
        toolsInLease: 0,
        requestedToolCalls: 20,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toMatchObject({ kind: "ALLOW" });
  });

  it("still refuses an oversized batch for a Run frozen under V1", () => {
    // A V1 policy's `maxToolCallsPerTurn` meant "the largest batch this Run may submit". Reinterpreting
    // a frozen policy would change a decision the Run already made, so the refusal stays.
    expect(
      evaluate(v1, {
        cumulativeAgentTurns: 1,
        cumulativeToolOperations: 0,
        turnsInLease: 1,
        toolsInLease: 0,
        requestedToolCalls: 20,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toMatchObject({ kind: "REPLAN", reason: "BATCH_TOO_LARGE" });
  });

  it("returns one cardinality-preserving synthetic result for every replan call", () => {
    const results = ResourceGovernor.replanResults([
      { externalCallId: "call-a", toolName: "list_directory" },
      { externalCallId: "call-b", toolName: "find_files" },
      { externalCallId: "call-c", toolName: "read_file" },
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((result) => result.externalCallId)).toEqual(["call-a", "call-b", "call-c"]);
    expect(results.every((result) => result.isError)).toBe(true);
  });
});
