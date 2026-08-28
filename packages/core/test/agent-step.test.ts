import {
  AgentKernelStateError,
  cancelAgentStep,
  completeAgentStep,
  createRunningAgentStep,
  failAgentStep,
  nextAgentStepSequence,
} from "../src/index.js";
import type { AgentState } from "@caelush/protocol";
import { AgentStepSchema, createRunId, createStepId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

function runningStep() {
  return createRunningAgentStep({
    id: createStepId(),
    runId: createRunId(),
    sequence: 1,
    startedAt: createTimestampMs(100),
  });
}

function stateWithSteps(steps: number): AgentState {
  return {
    runId: createRunId(),
    sessionId: "ses_0190f8b7-8c15-7abc-8a01-123456789abc" as AgentState["sessionId"],
    goal: "fixture",
    status: "RUNNING",
    workspace: {
      id: "wsp_0190f8b7-8c15-7abc-8a01-123456789abc" as AgentState["workspace"]["id"],
      path: "C:/workspace",
    },
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

describe("Agent step lifecycle", () => {
  it("creates a running step with caller-owned ID, sequence, and clock", () => {
    const step = runningStep();
    expect(AgentStepSchema.parse(step)).toEqual(step);
    expect(step).toMatchObject({
      status: "RUNNING",
      sequence: 1,
      startedAt: createTimestampMs(100),
    });
  });

  it("completes a running step and preserves its public reasoning summary", () => {
    const completed = completeAgentStep(runningStep(), {
      finishedAt: createTimestampMs(110),
      reasoningSummary: "Requested 1 tool call: read_file.",
    });
    expect(completed).toMatchObject({
      status: "COMPLETED",
      finishedAt: createTimestampMs(110),
      reasoningSummary: "Requested 1 tool call: read_file.",
    });
  });

  it("fails and cancels a running step at caller-provided timestamps", () => {
    expect(failAgentStep(runningStep(), createTimestampMs(120)).status).toBe("FAILED");
    expect(cancelAgentStep(runningStep(), createTimestampMs(120)).status).toBe("CANCELLED");
  });

  it("rejects terminal rewrites and a finish timestamp before start", () => {
    const step = runningStep();
    expect(() =>
      completeAgentStep(step, { finishedAt: createTimestampMs(99), reasoningSummary: "done" }),
    ).toThrow(AgentKernelStateError);
    const completed = completeAgentStep(step, {
      finishedAt: createTimestampMs(110),
      reasoningSummary: "done",
    });
    expect(() =>
      completeAgentStep(completed, {
        finishedAt: createTimestampMs(120),
        reasoningSummary: "again",
      }),
    ).toThrow(AgentKernelStateError);
    expect(() => failAgentStep(completed, createTimestampMs(120))).toThrow(AgentKernelStateError);
    expect(() => cancelAgentStep(completed, createTimestampMs(120))).toThrow(AgentKernelStateError);
  });

  it("returns the next sequence and rejects safe-integer overflow", () => {
    expect(nextAgentStepSequence(stateWithSteps(0))).toBe(1);
    expect(nextAgentStepSequence(stateWithSteps(7))).toBe(8);
    expect(() => nextAgentStepSequence(stateWithSteps(Number.MAX_SAFE_INTEGER))).toThrow(
      AgentKernelStateError,
    );
  });
});
