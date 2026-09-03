import type { RunResourcePolicy } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ProgressLedger } from "../src/progress-ledger.js";
import { ResourceGovernor } from "../src/resource-governor.js";

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

describe("adaptive long-run workload", () => {
  it("renews operational leases without applying a low lifetime Tool-call cap", () => {
    const governor = new ResourceGovernor(policy);
    const ledger = new ProgressLedger({ maxTurns: 4, maxFingerprints: 16 });
    let toolOperations = 0;
    let renewals = 0;

    for (let turn = 1; turn <= 12; turn += 1) {
      const decision = governor.evaluateToolBatch({
        agentTurnsConsumed: turn - 1,
        toolOperationsConsumed: toolOperations,
        requestedToolCalls: 1,
        progressLevel: "HEALTHY",
        replanCount: 0,
        currentLeaseEpoch: renewals + 1,
      });
      expect(["ALLOW", "RENEW_AND_ALLOW"]).toContain(decision.kind);
      if (decision.kind === "RENEW_AND_ALLOW") renewals += 1;
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
    expect(ledger.snapshot().consecutiveNoProgressTurns).toBe(0);
  });

  it("moves repeated no-progress work from replan to an explicit resource pause", () => {
    const governor = new ResourceGovernor(policy);
    const forced = governor.evaluateToolBatch({
      agentTurnsConsumed: 4,
      toolOperationsConsumed: 4,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 0,
    });
    expect(forced.kind).toBe("REPLAN");

    const paused = governor.evaluateToolBatch({
      agentTurnsConsumed: 8,
      toolOperationsConsumed: 8,
      requestedToolCalls: 1,
      progressLevel: "FORCED_REPLAN",
      replanCount: 2,
    });
    expect(paused).toEqual({ kind: "WAIT_FOR_RESOURCE_DECISION", reason: "NO_PROGRESS" });
  });
});
