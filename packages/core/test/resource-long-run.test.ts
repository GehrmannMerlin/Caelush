import type { RunResourcePolicy } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ProgressLedger } from "../src/progress-ledger.js";
import { ResourceGovernor } from "../src/resource-governor.js";

/**
 * A long, productive Run under each correction discipline.
 *
 * ```text
 * lease        renews on this epoch's spend, not on the Run's total
 * V1           repeated no-progress eventually asks a human
 * V2           repeated no-progress never does, and never refuses the batch in front of it
 * ```
 */

const policy: RunResourcePolicy = {
  mode: "ADAPTIVE",
  operationalLease: { maxAgentTurns: 4, maxToolOperations: 4 },
  batch: { maxToolCallsPerTurn: 2 },
  progress: {
    windowTurns: 4,
    identicalCallNudgeThreshold: 2,
    noProgressTurnsBeforeReplan: 3,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
};

const autonomous: RunResourcePolicy = { ...policy, correctionVersion: "AUTONOMOUS_CORRECTION_V2" };

describe("adaptive long-run workload", () => {
  it("renews operational leases without applying a low lifetime Tool-call cap", () => {
    const governor = new ResourceGovernor(policy);
    const ledger = new ProgressLedger({ maxTurns: 4, maxFingerprints: 16 });
    let toolOperations = 0;
    let renewals = 0;
    let leaseStartTurns = 0;
    let leaseStartTools = 0;

    for (let turn = 1; turn <= 12; turn += 1) {
      const decision = governor.evaluateToolBatch({
        cumulativeAgentTurns: turn - 1,
        cumulativeToolOperations: toolOperations,
        turnsInLease: turn - 1 - leaseStartTurns,
        toolsInLease: toolOperations - leaseStartTools,
        requestedToolCalls: 1,
        progressLevel: "HEALTHY",
        replanCount: 0,
        currentLeaseEpoch: renewals + 1,
      });
      expect(["ALLOW", "RENEW_AND_ALLOW"]).toContain(decision.kind);
      if (decision.kind === "RENEW_AND_ALLOW") {
        renewals += 1;
        leaseStartTurns = turn - 1;
        leaseStartTools = toolOperations;
      }
      toolOperations += 1;
      ledger.record({
        turn,
        requestFingerprint: `request-${turn}`,
        resultFingerprint: `result-${turn}`,
        signal: { kind: "NEW_OBSERVATION" },
      });
    }

    expect(toolOperations).toBe(12);
    expect(renewals).toBeGreaterThan(0);
    // One renewal per lease, not one per batch after the threshold: twelve batches against a
    // four-turn lease is at most three renewals, and never twelve.
    expect(renewals).toBeLessThanOrEqual(4);
    expect(ledger.snapshot().consecutiveNoProgressTurns).toBe(0);
  });

  it("moves repeated no-progress work from replan to an explicit resource pause under V1", () => {
    const governor = new ResourceGovernor(policy);
    const forced = governor.evaluateToolBatch({
      cumulativeAgentTurns: 4,
      cumulativeToolOperations: 4,
      turnsInLease: 0,
      toolsInLease: 0,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 0,
    });
    expect(forced.kind).toBe("REPLAN");

    const paused = governor.evaluateToolBatch({
      cumulativeAgentTurns: 8,
      cumulativeToolOperations: 8,
      turnsInLease: 4,
      toolsInLease: 4,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 2,
    });
    expect(paused).toEqual({ kind: "WAIT_FOR_RESOURCE_DECISION", reason: "NO_PROGRESS" });
  });

  it("keeps a V2 Run executing through repeated no-progress", () => {
    const governor = new ResourceGovernor(autonomous);
    for (const replanCount of [0, 1, 2, 5, 20]) {
      const decision = governor.evaluateToolBatch({
        cumulativeAgentTurns: 8,
        cumulativeToolOperations: 8,
        turnsInLease: 2,
        toolsInLease: 2,
        requestedToolCalls: 1,
        progressLevel: "FORCED_REPLAN",
        replanCount,
      });
      expect(decision.kind).toBe("ALLOW_WITH_NUDGE");
    }
  });
});
