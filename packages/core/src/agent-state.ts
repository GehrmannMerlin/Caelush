import type { ModelUsage } from "@caelush/ai";
import type { AgentRun, AgentState, StepId, TimestampMs } from "@caelush/protocol";
import { AgentStateSchema } from "@caelush/protocol";
import { assertRunStatusTransition } from "./run-state-machine.js";
import { AgentKernelStateError } from "./agent-errors.js";

export function createInitialAgentState(run: AgentRun, now: TimestampMs): AgentState {
  if (run.status !== "PENDING") {
    throw new AgentKernelStateError("initial state requires a PENDING run");
  }
  if (now < run.createdAt) {
    throw new AgentKernelStateError("initial state timestamp precedes run creation");
  }
  return AgentStateSchema.parse({
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status: "PENDING",
    workspace: run.workspace,
    runtime: run.runtime,
    permissionProfile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
    plan: [],
    recentObservations: [],
    changedFiles: [],
    activeProcesses: [],
    errors: [],
    verification: "NOT_RUN",
    usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: now,
  });
}

export function startAgentState(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", startedAt: now, updatedAt: now });
}

export function markAgentStateCancelled(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError("cancelled AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "CANCELLED");
  return AgentStateSchema.parse({
    ...state,
    status: "CANCELLED",
    updatedAt: now,
  });
}

export function markAgentStateTimedOut(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError("timed out AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "TIMEOUT");
  return AgentStateSchema.parse({
    ...state,
    status: "TIMEOUT",
    currentStepId: undefined,
    activeProcesses: [],
    updatedAt: now,
  });
}

export function markAgentStateBudgetExceeded(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError("budget-exceeded AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "BUDGET_EXCEEDED");
  return AgentStateSchema.parse({ ...state, status: "BUDGET_EXCEEDED", updatedAt: now });
}

export function beginAgentStepState(
  state: AgentState,
  stepId: StepId,
  now: TimestampMs,
): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "RUNNING") {
    throw new AgentKernelStateError("agent step requires a RUNNING state");
  }
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError("agent state already has an active step");
  }
  return AgentStateSchema.parse({ ...state, currentStepId: stepId, updatedAt: now });
}

export interface SettleAgentStepInput {
  readonly stepId: StepId;
  readonly usage?: ModelUsage;
  readonly now: TimestampMs;
}

export interface CancelAgentStepStateInput {
  readonly stepId: StepId;
  readonly now: TimestampMs;
  readonly countAttempt: boolean;
}

export function cancelAgentStepState(
  state: AgentState,
  input: CancelAgentStepStateInput,
): AgentState {
  assertMonotonicTimestamp(state, input.now);
  if (state.status !== "RUNNING" || state.currentStepId !== input.stepId) {
    throw new AgentKernelStateError("agent step cancellation does not match the active step");
  }
  return AgentStateSchema.parse({
    ...state,
    currentStepId: undefined,
    usage: input.countAttempt ? { ...state.usage, steps: state.usage.steps + 1 } : state.usage,
    updatedAt: input.now,
  });
}

export function settleAgentStepState(state: AgentState, input: SettleAgentStepInput): AgentState {
  assertMonotonicTimestamp(state, input.now);
  if (state.status !== "RUNNING") {
    throw new AgentKernelStateError("agent step settlement requires a RUNNING state");
  }
  if (state.currentStepId !== input.stepId) {
    throw new AgentKernelStateError("agent step settlement does not match the active step");
  }
  return AgentStateSchema.parse({
    ...state,
    currentStepId: undefined,
    usage: {
      ...state.usage,
      steps: state.usage.steps + 1,
      ...(input.usage?.inputTokens === undefined
        ? {}
        : { inputTokens: state.usage.inputTokens + input.usage.inputTokens }),
      ...(input.usage?.outputTokens === undefined
        ? {}
        : { outputTokens: state.usage.outputTokens + input.usage.outputTokens }),
    },
    updatedAt: input.now,
  });
}

export function markAgentStateVerifying(state: AgentState, now: TimestampMs): AgentState {
  assertBoundaryState(state, "VERIFYING", now);
  return AgentStateSchema.parse({
    ...state,
    status: "VERIFYING",
    verification: "NOT_RUN",
    updatedAt: now,
  });
}

export function markAgentStateCompleted(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "VERIFYING" || state.currentStepId !== undefined) {
    throw new AgentKernelStateError("state cannot complete outside the verification boundary");
  }
  assertRunStatusTransition(state.status, "COMPLETED");
  return AgentStateSchema.parse({
    ...state,
    status: "COMPLETED",
    verification: "PASSED",
    updatedAt: now,
  });
}

export function markAgentStateWaitingApproval(state: AgentState, now: TimestampMs): AgentState {
  assertBoundaryState(state, "WAITING_APPROVAL", now);
  return AgentStateSchema.parse({
    ...state,
    status: "WAITING_APPROVAL",
    currentStepId: undefined,
    updatedAt: now,
  });
}

export function markAgentStateWaitingResource(state: AgentState, now: TimestampMs): AgentState {
  assertBoundaryState(state, "WAITING_RESOURCE", now);
  return AgentStateSchema.parse({
    ...state,
    status: "WAITING_RESOURCE",
    currentStepId: undefined,
    updatedAt: now,
  });
}

export function resumeAgentStateFromResource(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "WAITING_RESOURCE") {
    throw new AgentKernelStateError(
      "state cannot resume from a resource guard unless it is waiting",
    );
  }
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", updatedAt: now });
}

export function resumeAgentStateFromApproval(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "WAITING_APPROVAL") {
    throw new AgentKernelStateError("state cannot resume from approval unless it is waiting");
  }
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", updatedAt: now });
}

export function resumeAgentStateFromVerificationRepair(
  state: AgentState,
  now: TimestampMs,
): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "VERIFYING" || state.currentStepId !== undefined) {
    throw new AgentKernelStateError("state cannot resume verification repair from this boundary");
  }
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({
    ...state,
    status: "RUNNING",
    currentStepId: undefined,
    updatedAt: now,
  });
}

export function markAgentStateMaxStepsReached(state: AgentState, now: TimestampMs): AgentState {
  assertBoundaryState(state, "MAX_STEPS_REACHED", now);
  return AgentStateSchema.parse({ ...state, status: "MAX_STEPS_REACHED", updatedAt: now });
}

function assertBoundaryState(
  state: AgentState,
  target: "WAITING_APPROVAL" | "WAITING_RESOURCE" | "VERIFYING" | "MAX_STEPS_REACHED",
  now: TimestampMs,
): void {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "RUNNING") {
    throw new AgentKernelStateError(`state cannot transition to ${target}`);
  }
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError(`state cannot transition to ${target} with an active step`);
  }
  assertRunStatusTransition(state.status, target);
}

function assertMonotonicTimestamp(state: AgentState, now: TimestampMs): void {
  if (now < state.updatedAt) {
    throw new AgentKernelStateError("state timestamp moved backwards");
  }
}
