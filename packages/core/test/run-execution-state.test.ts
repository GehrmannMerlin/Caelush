import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createInitialAgentState,
  markAgentStateWaitingApproval,
  startAgentState,
} from "../src/agent-state.js";
import { createRunningAgentStep, beginAgentStepState } from "../src/index.js";
import {
  assertRunExecutionInvariant,
  markAgentRunFailed,
  markAgentRunWaitingApproval,
  markAgentStateFailed,
} from "../src/run-execution-state.js";
import { RunContinuationCheckpointSchema } from "../src/agent-continuation-schema.js";
import type { RunContinuationCheckpoint } from "../src/agent-continuation.js";

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

  it("marks Run and State waiting for approval without a current Step", () => {
    const pending = run();
    const running = { ...pending, status: "RUNNING" as const, startedAt: createTimestampMs(2) };
    const state = startAgentState(
      createInitialAgentState(pending, createTimestampMs(1)),
      createTimestampMs(2),
    );
    expect(markAgentRunWaitingApproval(running).status).toBe("WAITING_APPROVAL");
    expect(markAgentStateWaitingApproval(state, createTimestampMs(3)).status).toBe(
      "WAITING_APPROVAL",
    );
  });

  it("requires an approval pointer and forbids accepted results at the approval boundary", () => {
    const pending = run();
    const waitingRun = {
      ...pending,
      status: "WAITING_APPROVAL" as const,
      startedAt: createTimestampMs(2),
    };
    const waitingState = markAgentStateWaitingApproval(
      startAgentState(createInitialAgentState(pending, createTimestampMs(1)), createTimestampMs(2)),
      createTimestampMs(3),
    );
    const checkpoint = RunContinuationCheckpointSchema.parse({
      type: "WAITING_TOOL_RESULTS",
      runId: pending.id,
      sourceStepId: createStepId(),
      pendingDecision: {
        type: "TOOL_CALLS_REQUESTED",
        modelTurn: {
          callId: "llm_019d0f70-0000-7000-8000-000000000001",
          model: { provider: "fixture", model: "fixture-model" },
          finishReason: "TOOL_CALLS",
          assistantMessage: {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: {} }],
          },
        },
        toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: {} }],
      },
      waitingApproval: {
        invocationId: "tinv_019d0f70-0000-7000-8000-000000000001",
        externalCallId: "call_a",
        toolName: "read_file",
      },
    });
    expect(() =>
      assertRunExecutionInvariant({ run: waitingRun, state: waitingState, continuation: checkpoint, conversation: [] }),
    ).not.toThrow();
    expect(() =>
      assertRunExecutionInvariant({
        run: waitingRun,
        state: waitingState,
        continuation: ({
          ...checkpoint,
          receivedResults: [
            {
              role: "tool",
              toolCallId: "call_a",
              toolName: "read_file",
              content: "x",
              isError: false,
            },
          ],
        } as unknown) as RunContinuationCheckpoint,
        conversation: [],
      }),
    ).toThrow();
  });
});
