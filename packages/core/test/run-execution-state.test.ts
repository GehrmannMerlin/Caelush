import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { createRunningAgentStep, beginAgentStepState } from "../src/index.js";
import {
  assertRunExecutionInvariant,
  markAgentRunFailed,
  markAgentStateFailed,
} from "../src/run-execution-state.js";

function run() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "goal",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
}

describe("durable Run execution state", () => {
  it("marks a running Run and State failed with one sanitized error", () => {
    const pending = run();
    const running = { ...pending, status: "RUNNING" as const, startedAt: createTimestampMs(2) };
    const state = startAgentState(
      createInitialAgentState(pending, createTimestampMs(1)),
      createTimestampMs(2),
    );
    const error = {
      code: "INTERNAL_ERROR" as const,
      message: "safe",
      retryable: false,
      phase: "RUNTIME" as const,
    };

    const failedRun = markAgentRunFailed(running, createTimestampMs(3));
    expect(failedRun).toMatchObject({ status: "FAILED", finishedAt: 3 });
    expect(failedRun).not.toHaveProperty("finalResult");
    const failedState = markAgentStateFailed(state, error, createTimestampMs(3));
    expect(failedState).toMatchObject({
      status: "FAILED",
      errors: [error],
    });
    expect(failedState).not.toHaveProperty("currentStepId");
  });

  it("rejects an active Step on a terminal Run and accepts the PENDING exception", () => {
    const pending = run();
    expect(() => assertRunExecutionInvariant({ run: pending, conversation: [] })).not.toThrow();

    const running = { ...pending, status: "RUNNING" as const, startedAt: createTimestampMs(2) };
    const state = startAgentState(
      createInitialAgentState(pending, createTimestampMs(1)),
      createTimestampMs(2),
    );
    const step = createRunningAgentStep({
      id: createStepId(),
      runId: running.id,
      sequence: 1,
      startedAt: createTimestampMs(3),
    });
    const activeState = beginAgentStepState(state, step.id, createTimestampMs(3));
    expect(() =>
      assertRunExecutionInvariant({
        run: { ...running, status: "FAILED", currentStepId: step.id },
        state: { ...activeState, status: "FAILED" },
        activeStep: step,
        conversation: [],
      }),
    ).toThrow();
  });
});
