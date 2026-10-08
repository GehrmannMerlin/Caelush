import { describe, expect, it } from "vitest";
import { ResourceGovernanceStateSchema } from "@caelush/storage";
import { createRunId, createTimestampMs } from "@caelush/protocol";
import { projectModelResourceGovernance } from "../src/context/resource-governance-context.js";

describe("model-facing resource governance context", () => {
  it("omits diagnostic counters while preserving mode and guard transitions", () => {
    const state = ResourceGovernanceStateSchema.parse({
      runId: createRunId(),
      policyVersion: "adaptive-resource-governance.v1",
      mode: "ADAPTIVE",
      leaseEpoch: 1,
      leaseStartAgentTurns: 0,
      leaseStartToolCalls: 0,
      agentTurnsConsumed: 5,
      toolOperationsConsumed: 8,
      consecutiveNoProgressTurns: 0,
      replanCount: 0,
      resourceGuardState: "NONE",
      recentFingerprints: [],
      revision: 1,
      createdAt: createTimestampMs(1_000),
      updatedAt: createTimestampMs(1_000),
    });

    const laterCounters = {
      ...state,
      agentTurnsConsumed: 7,
      toolOperationsConsumed: 10,
      revision: 3,
      updatedAt: createTimestampMs(3_000),
    };
    const guardChanged = { ...laterCounters, resourceGuardState: "NUDGE" as const };

    expect(projectModelResourceGovernance(state)).toBe("ADAPTIVE:NONE");
    expect(projectModelResourceGovernance(laterCounters)).toBe("ADAPTIVE:NONE");
    expect(projectModelResourceGovernance(guardChanged)).toBe("ADAPTIVE:NUDGE");
    expect(projectModelResourceGovernance({ ...state, mode: "LEGACY_FIXED" })).toBe(
      "LEGACY_FIXED:NONE",
    );
    expect(
      projectModelResourceGovernance({ ...laterCounters, resourceGuardState: "REPLAN_REQUIRED" }),
    ).toBe("ADAPTIVE:REPLAN_REQUIRED");
    expect(projectModelResourceGovernance(null)).toBe("NO_RESOURCE_STATE");
  });
});
