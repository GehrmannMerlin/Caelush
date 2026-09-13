import type { ModelUsage } from "@caelush/ai";
import type { AgentState, StepId, TimestampMs } from "@caelush/protocol";
import { AgentStateSchema } from "@caelush/protocol";

import { AgentStepStateError } from "./step-lifecycle.js";

/**
 * The canonical AgentState projection of the active durable Step.
 *
 * `AgentRun.currentStepId` and `AgentState.currentStepId` are two projections of one fact, so the
 * same transition that moves the Step moves both: opening a Step sets each, settling it clears
 * each, and the durable invariant check refuses a snapshot where they disagree.
 *
 * The functions are pure and total. They return a new state rather than mutating one, which is
 * what lets a transition be computed — and rejected — before anything is written.
 */

/** Open the active Step of a RUNNING AgentState. */
export function beginAgentStepState(
  state: AgentState,
  stepId: StepId,
  now: TimestampMs,
): AgentState {
  assertMonotonicTimestamp(state, now);
  if (state.status !== "RUNNING") {
    throw new AgentStepStateError("agent step requires a RUNNING state");
  }
  if (state.currentStepId !== undefined) {
    throw new AgentStepStateError("agent state already has an active step");
  }
  return AgentStateSchema.parse({ ...state, currentStepId: stepId, updatedAt: now });
}

export interface SettleAgentStepInput {
  readonly stepId: StepId;
  /** The settled usage, when the attempt reported one. */
  readonly usage?: ModelUsage;
  readonly now: TimestampMs;
}

export interface CancelAgentStepStateInput {
  readonly stepId: StepId;
  readonly now: TimestampMs;
  /**
   * Whether this cancellation counts as a settled attempt.
   *
   * A cancellation that happened after the provider was contacted did spend an attempt; one that
   * happened before did not. The caller observed which, so it says which.
   */
  readonly countAttempt: boolean;
}

/** Clear the active Step of a cancelled attempt. */
export function cancelAgentStepState(
  state: AgentState,
  input: CancelAgentStepStateInput,
): AgentState {
  assertMonotonicTimestamp(state, input.now);
  if (state.status !== "RUNNING" || state.currentStepId !== input.stepId) {
    throw new AgentStepStateError("agent step cancellation does not match the active step");
  }
  return AgentStateSchema.parse({
    ...state,
    currentStepId: undefined,
    usage: input.countAttempt ? { ...state.usage, steps: state.usage.steps + 1 } : state.usage,
    updatedAt: input.now,
  });
}

/**
 * Clear the active Step and count the settled attempt.
 *
 * `steps` counts settled attempts including failed ones, and provider usage is accumulated when
 * the attempt reported any. A step that produced no usage still counts as an attempt: it was made.
 */
export function settleAgentStepState(state: AgentState, input: SettleAgentStepInput): AgentState {
  assertMonotonicTimestamp(state, input.now);
  if (state.status !== "RUNNING") {
    throw new AgentStepStateError("agent step settlement requires a RUNNING state");
  }
  if (state.currentStepId !== input.stepId) {
    throw new AgentStepStateError("agent step settlement does not match the active step");
  }
  return AgentStateSchema.parse({
    ...state,
    currentStepId: undefined,
    usage: settleUsage(state, input.usage),
    updatedAt: input.now,
  });
}

function settleUsage(state: AgentState, usage: ModelUsage | undefined): AgentState["usage"] {
  const steps = state.usage.steps + 1;
  if (usage === undefined) return { ...state.usage, steps };
  return {
    ...state.usage,
    steps,
    inputTokens: state.usage.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: state.usage.outputTokens + (usage.outputTokens ?? 0),
  };
}

function assertMonotonicTimestamp(state: AgentState, now: TimestampMs): void {
  if (now < state.updatedAt) {
    throw new AgentStepStateError("agent state timestamp moved backwards");
  }
}
