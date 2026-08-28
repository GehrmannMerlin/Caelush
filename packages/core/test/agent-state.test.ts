import {
  AgentKernelStateError,
  beginAgentStepState,
  createInitialAgentState,
  markAgentStateMaxStepsReached,
  markAgentStateVerifying,
  settleAgentStepState,
  startAgentState,
} from "../src/index.js";
import type { AgentRun, AgentState, StepId } from "@caelush/protocol";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect the project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    ...overrides,
  });
}

function startedState(steps = 0): AgentState {
  const initial = createInitialAgentState(run(), createTimestampMs(100));
  const started = startAgentState(initial, createTimestampMs(110));
  return { ...started, usage: { ...started.usage, steps } };
}

describe("Agent state kernel", () => {
  it("creates the compact initial projection from a pending run", () => {
    const source = run();
    expect(createInitialAgentState(source, createTimestampMs(200))).toEqual({
      runId: source.id,
      sessionId: source.sessionId,
      goal: source.goal,
      status: "PENDING",
      workspace: source.workspace,
      runtime: source.runtime,
      permissionProfile: source.permissionProfile,
      approvalPolicy: source.approvalPolicy,
      currentStepId: undefined,
      plan: [],
      recentObservations: [],
      changedFiles: [],
      activeProcesses: [],
      errors: [],
      verification: "NOT_RUN",
      usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      startedAt: undefined,
      updatedAt: createTimestampMs(200),
    });
  });

  it("rejects non-pending runs and timestamps before run creation", () => {
    expect(() =>
      createInitialAgentState(run({ status: "RUNNING" }), createTimestampMs(100)),
    ).toThrow(AgentKernelStateError);
    expect(() => createInitialAgentState(run(), createTimestampMs(99))).toThrow(
      AgentKernelStateError,
    );
  });

  it("starts a pending state and enforces monotonic timestamps", () => {
    const state = createInitialAgentState(run(), createTimestampMs(100));
    expect(startAgentState(state, createTimestampMs(110))).toMatchObject({
      status: "RUNNING",
      startedAt: createTimestampMs(110),
      updatedAt: createTimestampMs(110),
    });
    expect(() => startAgentState(startAgentState(state, createTimestampMs(110)), createTimestampMs(109))).toThrow(
      AgentKernelStateError,
    );
  });

  it("begins and settles the current step while accumulating known LLM usage", () => {
    const state = startedState();
    const stepId = createStepId();
    const active = beginAgentStepState(state, stepId, createTimestampMs(120));
    expect(active.currentStepId).toBe(stepId);
    expect(active.usage.steps).toBe(0);
    const settled = settleAgentStepState(active, {
      stepId,
      usage: { inputTokens: 50, outputTokens: 10 },
      now: createTimestampMs(130),
    });
    expect(settled.currentStepId).toBeUndefined();
    expect(settled.usage).toEqual({ steps: 1, toolCalls: 0, inputTokens: 50, outputTokens: 10 });
  });

  it("counts a settled step without usage and preserves missing token totals", () => {
    const state = startedState();
    const stepId = createStepId();
    const active = beginAgentStepState(state, stepId, createTimestampMs(120));
    const withInput = { ...active, usage: { ...active.usage, inputTokens: 100, outputTokens: 20 } };
    const settled = settleAgentStepState(withInput, {
      stepId,
      usage: { outputTokens: 10, totalTokens: 999 } as never,
      now: createTimestampMs(130),
    });
    expect(settled.usage).toEqual({ steps: 1, toolCalls: 0, inputTokens: 100, outputTokens: 30 });
  });

  it("rejects invalid active-step operations and moves only idle running state to boundaries", () => {
    const state = startedState();
    const stepId: StepId = createStepId();
    const active = beginAgentStepState(state, stepId, createTimestampMs(120));
    expect(() => beginAgentStepState(active, createStepId(), createTimestampMs(121))).toThrow(
      AgentKernelStateError,
    );
    expect(() => settleAgentStepState(active, { stepId: createStepId(), now: createTimestampMs(121) })).toThrow(
      AgentKernelStateError,
    );
    expect(() => markAgentStateVerifying(active, createTimestampMs(121))).toThrow(AgentKernelStateError);
    const idle = settleAgentStepState(active, { stepId, now: createTimestampMs(130) });
    expect(markAgentStateVerifying(idle, createTimestampMs(140))).toMatchObject({
      status: "VERIFYING",
      verification: "NOT_RUN",
    });
    expect(markAgentStateMaxStepsReached(idle, createTimestampMs(150)).status).toBe(
      "MAX_STEPS_REACHED",
    );
  });
});
