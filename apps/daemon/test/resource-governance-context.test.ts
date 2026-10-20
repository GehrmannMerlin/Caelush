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

  it("carries a prepared correction as actionable text, not just its label", () => {
    // The projection is the delivery channel for repeated-mistake guidance. Projecting `mode:state` and
    // nothing else meant a Run could decide the model needed specific advice, produce it, and then hand
    // the model four characters of accounting instead.
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
      resourceGuardState: "NUDGE",
      recentFingerprints: [],
      revision: 1,
      createdAt: createTimestampMs(1_000),
      updatedAt: createTimestampMs(1_000),
      semanticProgress: {
        version: 1,
        turns: [],
        correction: {
          interventionId: "abc:INPUT_CORRECTION:0:step-1",
          stage: "INPUT_CORRECTION",
          patternKey: "a".repeat(64),
          toolName: "apply_patch",
          code: "TOOL_ARGUMENT_ERROR",
          occurrences: 3,
          guidance: 'Use the declared argument shape and change exactly "patch".',
          sourceStepId: "step-1",
        },
      },
    });

    const projection = projectModelResourceGovernance(state);
    expect(projection).toContain("ADAPTIVE:NUDGE");
    expect(projection).toContain("PENDING_CORRECTION");
    expect(projection).toContain("stage=INPUT_CORRECTION");
    expect(projection).toContain("tool=apply_patch");
    expect(projection).toContain("occurrences=3");
    expect(projection).toContain('change exactly "patch"');
  });

  it("returns to the plain summary once the correction has been delivered", () => {
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
      resourceGuardState: "NUDGE",
      recentFingerprints: [],
      revision: 2,
      createdAt: createTimestampMs(1_000),
      updatedAt: createTimestampMs(2_000),
      semanticProgress: {
        version: 1,
        turns: [],
        active: {
          key: "a".repeat(64),
          toolName: "apply_patch",
          code: "TOOL_ARGUMENT_ERROR",
          replans: 0,
          nudged: true,
          deliveredInterventions: 1,
        },
      },
    });
    expect(projectModelResourceGovernance(state)).toBe("ADAPTIVE:NUDGE");
  });
});
