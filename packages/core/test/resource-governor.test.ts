import { describe, expect, it } from "vitest";
import { ResourceGovernor } from "../src/resource-governor.js";

const policy = {
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

describe("ResourceGovernor", () => {
  it("renews a healthy operational lease instead of terminally rejecting the batch", () => {
    const result = new ResourceGovernor(policy).evaluateToolBatch({
      agentTurnsConsumed: 24,
      toolOperationsConsumed: 63,
      requestedToolCalls: 5,
      progressLevel: "HEALTHY",
      replanCount: 0,
    });

    expect(result).toEqual({ kind: "RENEW_AND_ALLOW", nextLeaseEpoch: 2 });
  });

  it("keeps the per-turn batch bound separate from lifetime operations", () => {
    const result = new ResourceGovernor(policy).evaluateToolBatch({
      agentTurnsConsumed: 2,
      toolOperationsConsumed: 200,
      requestedToolCalls: 17,
      progressLevel: "HEALTHY",
      replanCount: 0,
    });

    expect(result.kind).toBe("REPLAN");
    if (result.kind === "REPLAN") expect(result.requestedToolCalls).toBe(17);
  });

  it("enforces explicit hard Tool ceilings and pauses repeated no-progress replans", () => {
    expect(
      new ResourceGovernor({
        ...policy,
        hardLimits: { maxToolCalls: 8 },
      }).evaluateToolBatch({
        agentTurnsConsumed: 4,
        toolOperationsConsumed: 4,
        requestedToolCalls: 5,
        progressLevel: "HEALTHY",
        replanCount: 0,
      }),
    ).toMatchObject({ kind: "HARD_STOP", dimension: "TOOL_CALLS", limit: 8 });

    expect(
      new ResourceGovernor(policy).evaluateToolBatch({
        agentTurnsConsumed: 4,
        toolOperationsConsumed: 100,
        requestedToolCalls: 1,
        progressLevel: "FORCED_REPLAN",
        replanCount: 2,
      }),
    ).toMatchObject({ kind: "WAIT_FOR_RESOURCE_DECISION" });
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
