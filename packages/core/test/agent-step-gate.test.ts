import {
  AgentKernelStateError,
  evaluateAgentStepGate,
} from "../src/index.js";
import type { AgentState, RunLimits } from "@caelush/protocol";
import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

function state(steps: number, status: AgentState["status"] = "RUNNING"): AgentState {
  return {
    runId: createRunId(),
    sessionId: createSessionId(),
    goal: "fixture",
    status,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    plan: [],
    recentObservations: [],
    changedFiles: [],
    activeProcesses: [],
    errors: [],
    verification: "NOT_RUN",
    usage: { steps, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: createTimestampMs(100),
  };
}

const limits: RunLimits = {
  maxSteps: 8,
  maxToolCalls: 1,
  timeoutMs: 1,
  maxTokens: 1,
  maxCost: 0,
};

describe("Agent step gate", () => {
  it.each([
    [0, { allowed: true, nextSequence: 1 }],
    [7, { allowed: true, nextSequence: 8 }],
  ] as const)("allows %s of maxSteps with the next sequence", (steps, expected) => {
    expect(evaluateAgentStepGate(state(steps), limits)).toEqual(expected);
  });

  it.each([8, 9])("returns expected MAX_STEPS_REACHED at and beyond the boundary", (steps) => {
    expect(evaluateAgentStepGate(state(steps), limits)).toEqual({
      allowed: false,
      outcome: { type: "MAX_STEPS_REACHED", stepsCompleted: steps, maxSteps: 8 },
    });
  });

  it("rejects a non-running state or an already active step", () => {
    expect(() => evaluateAgentStepGate(state(0, "VERIFYING"), limits)).toThrow(AgentKernelStateError);
    expect(() =>
      evaluateAgentStepGate({ ...state(0), currentStepId: createStepId() }, limits),
    ).toThrow(AgentKernelStateError);
  });

  it("does not enforce maxToolCalls, timeout, token, or cost limits", () => {
    const result = evaluateAgentStepGate(state(0), {
      maxSteps: 8,
      maxToolCalls: 999,
      timeoutMs: 999,
      maxTokens: 999,
      maxCost: 999,
    });
    expect(result).toEqual({ allowed: true, nextSequence: 1 });
  });
});
