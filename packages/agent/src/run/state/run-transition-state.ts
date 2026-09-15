import type { AgentError, AgentRun, AgentState, JsonValue, TimestampMs } from "@caelush/protocol";
import { AgentErrorSchema, AgentRunSchema, AgentStateSchema } from "@caelush/protocol";

import { RunExecutionInvariantError } from "../ports/run-execution-store.js";
import { AgentStepStateError } from "../turn/step-lifecycle.js";
import { assertRunStatusTransition } from "./run-state-machine.js";

/**
 * The general durable Run and AgentState transitions.
 *
 * ```text
 * general       this file       a Run and its AgentState move together, for any Run
 * verification  @caelush/core   a VERIFYING Run is bound to the plan it is verifying
 * ```
 *
 * These are the mutations a Run Layer performs on durable state. They are pure: each returns a new
 * entity and writes nothing, so a transition can be computed — and refused — before anything is
 * committed. Every one parses its result through the Protocol schema, because moving the owner of a
 * mutation must not weaken the constraints on what it may produce.
 *
 * The error classes are the ones these transitions already threw before the move — the kernel's
 * `RunExecutionInvariantError` for a Run, its `AgentStepStateError` for an AgentState. A migration
 * that changed which class a caller had to catch would be a behaviour change, not a move.
 *
 * Deliberately absent: `VerificationPlan`, `VerifiedRunFinalResult`, a completion seal, workspace
 * or Git evidence. Those are coding-verification artefacts, and a general Run must be able to
 * settle without one: {@link completeAgentRunWithFinalResult} accepts the general `JsonValue` that
 * `AgentRun.finalResult` is declared as, and {@link completeAgentState} asserts only the
 * Protocol-level completion status the durable invariant already requires.
 */

/* ------------------------------------------------------------- AgentState */

/** The AgentState projection of a failed Run. */
export function markAgentStateFailed(
  state: AgentState,
  error: AgentError,
  now: TimestampMs,
): AgentState {
  if (state.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("failed AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "FAILED");
  const parsedError = AgentErrorSchema.parse(error);
  return AgentStateSchema.parse({
    ...state,
    status: "FAILED",
    errors: [...state.errors, parsedError],
    updatedAt: now,
  });
}

/** The AgentState projection of a cancelled Run. */
export function markAgentStateCancelled(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentStepStateError("cancelled AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "CANCELLED");
  return AgentStateSchema.parse({
    ...state,
    status: "CANCELLED",
    updatedAt: now,
  });
}

/** The AgentState projection of a Run that ran out of wall-clock time. */
export function markAgentStateTimedOut(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentStepStateError("timed out AgentState cannot retain an active Step");
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

/** The AgentState projection of a Run that exhausted its durable budget. */
export function markAgentStateBudgetExceeded(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.currentStepId !== undefined) {
    throw new AgentStepStateError("budget-exceeded AgentState cannot retain an active Step");
  }
  assertRunStatusTransition(state.status, "BUDGET_EXCEEDED");
  return AgentStateSchema.parse({ ...state, status: "BUDGET_EXCEEDED", updatedAt: now });
}

/** The AgentState projection of a Run that exhausted its structural step budget. */
export function markAgentStateMaxStepsReached(state: AgentState, now: TimestampMs): AgentState {
  assertAgentStateBoundary(state, "MAX_STEPS_REACHED", now);
  return AgentStateSchema.parse({ ...state, status: "MAX_STEPS_REACHED", updatedAt: now });
}

/**
 * The AgentState projection of a Run that stopped for a completion decision.
 *
 * It asserts the Protocol status and resets the verification field to `NOT_RUN`. It does **not**
 * know what a verification plan is: *whether* a candidate may complete is the completion
 * authority's question, and this only records that the Run is now asking it.
 */
export function markAgentStateVerifying(state: AgentState, now: TimestampMs): AgentState {
  assertAgentStateBoundary(state, "VERIFYING", now);
  return AgentStateSchema.parse({
    ...state,
    status: "VERIFYING",
    verification: "NOT_RUN",
    updatedAt: now,
  });
}

/** The AgentState projection of an approval boundary. */
export function markAgentStateWaitingApproval(state: AgentState, now: TimestampMs): AgentState {
  assertAgentStateBoundary(state, "WAITING_APPROVAL", now);
  return AgentStateSchema.parse({
    ...state,
    status: "WAITING_APPROVAL",
    currentStepId: undefined,
    updatedAt: now,
  });
}

/** The AgentState projection of a resource boundary. */
export function markAgentStateWaitingResource(state: AgentState, now: TimestampMs): AgentState {
  assertAgentStateBoundary(state, "WAITING_RESOURCE", now);
  return AgentStateSchema.parse({
    ...state,
    status: "WAITING_RESOURCE",
    currentStepId: undefined,
    updatedAt: now,
  });
}

/** The AgentState that resumed from a resource boundary. */
export function resumeAgentStateFromResource(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.status !== "WAITING_RESOURCE") {
    throw new AgentStepStateError("state cannot resume from a resource guard unless it is waiting");
  }
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", updatedAt: now });
}

/** The AgentState that resumed from an approval boundary. */
export function resumeAgentStateFromApproval(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.status !== "WAITING_APPROVAL") {
    throw new AgentStepStateError("state cannot resume from approval unless it is waiting");
  }
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", updatedAt: now });
}

/**
 * The AgentState of a Run whose accepted result settled it.
 *
 * `verification: "PASSED"` is not a coding claim: it is the Protocol field the durable Run
 * execution invariant already requires of a COMPLETED Run, and the acceptance itself was decided by
 * whichever completion authority the host composed. This function records the outcome; it does not
 * produce it.
 */
export function completeAgentState(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.status !== "VERIFYING" || state.currentStepId !== undefined) {
    throw new AgentStepStateError("state cannot complete outside the completion boundary");
  }
  assertRunStatusTransition(state.status, "COMPLETED");
  return AgentStateSchema.parse({
    ...state,
    status: "COMPLETED",
    verification: "PASSED",
    updatedAt: now,
  });
}

/** Refuse a state transition whose timestamp would move backwards. */
export function assertMonotonicAgentStateTimestamp(state: AgentState, now: TimestampMs): void {
  if (now < state.updatedAt) {
    throw new AgentStepStateError("state timestamp moved backwards");
  }
}

function assertAgentStateBoundary(
  state: AgentState,
  target: "WAITING_APPROVAL" | "WAITING_RESOURCE" | "VERIFYING" | "MAX_STEPS_REACHED",
  now: TimestampMs,
): void {
  assertMonotonicAgentStateTimestamp(state, now);
  if (state.status !== "RUNNING") {
    throw new AgentStepStateError(`state cannot transition to ${target}`);
  }
  if (state.currentStepId !== undefined) {
    throw new AgentStepStateError(`state cannot transition to ${target} with an active step`);
  }
  assertRunStatusTransition(state.status, target);
}

/* -------------------------------------------------------------- AgentRun */

/** The Run projection of a failed Run. */
export function failAgentRun(run: AgentRun, now: TimestampMs): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("failed AgentRun cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "FAILED");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  return AgentRunSchema.parse({
    ...withoutFinalResult,
    status: "FAILED",
    finishedAt: now,
  });
}

/** The Run projection of a cancelled Run. */
export function cancelAgentRun(run: AgentRun, now: TimestampMs): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("cancelled AgentRun cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "CANCELLED");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  return AgentRunSchema.parse({
    ...withoutFinalResult,
    status: "CANCELLED",
    finishedAt: now,
  });
}

/** The Run projection of a Run that ran out of wall-clock time. */
export function timeOutAgentRun(run: AgentRun, now: TimestampMs): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("timed out AgentRun cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "TIMEOUT");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  return AgentRunSchema.parse({
    ...withoutFinalResult,
    status: "TIMEOUT",
    finishedAt: now,
  });
}

/** The Run projection of a Run that exhausted its durable budget. */
export function markAgentRunBudgetExceeded(run: AgentRun, now: TimestampMs): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("budget-exceeded AgentRun cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "BUDGET_EXCEEDED");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  return AgentRunSchema.parse({
    ...withoutFinalResult,
    status: "BUDGET_EXCEEDED",
    finishedAt: now,
  });
}

/** The Run projection of a Run that exhausted its structural step budget. */
export function markAgentRunMaxStepsReached(run: AgentRun, now: TimestampMs): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("max-steps AgentRun cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "MAX_STEPS_REACHED");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  return AgentRunSchema.parse({
    ...withoutFinalResult,
    status: "MAX_STEPS_REACHED",
    finishedAt: now,
  });
}

/**
 * The Run that accepted a final result.
 *
 * `finalResult` is the Protocol `JsonValue` the Run schema already declares, **not** a
 * `VerifiedRunFinalResult`: a general Run completes with whatever its completion authority
 * accepted, and the coding-verification result type is one such value rather than the only one.
 */
export function completeAgentRunWithFinalResult(
  run: AgentRun,
  finalResult: JsonValue,
  now: TimestampMs,
): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("completed AgentRun cannot retain an active Step");
  }
  if (run.status !== "VERIFYING") {
    throw new RunExecutionInvariantError("only VERIFYING AgentRuns can complete");
  }
  assertRunStatusTransition(run.status, "COMPLETED");
  return AgentRunSchema.parse({
    ...run,
    status: "COMPLETED",
    finishedAt: now,
    finalResult,
  });
}

/** The Run projection of a boundary only an external resolution can move. */
export function markAgentRunWaitingApproval(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("waiting Approval Run cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "WAITING_APPROVAL");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "WAITING_APPROVAL" });
}

/** The Run projection of a resource boundary. */
export function markAgentRunWaitingResource(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("resource-waiting Run cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "WAITING_RESOURCE");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "WAITING_RESOURCE" });
}

/** The Run projection of a Run that resumed from a resource boundary. */
export function resumeAgentRunFromResource(run: AgentRun): AgentRun {
  return resumeRunToRunning(run);
}

/** The Run projection of a Run that resumed from an approval boundary. */
export function resumeAgentRunFromApproval(run: AgentRun): AgentRun {
  return resumeRunToRunning(run);
}

/**
 * The Run projection of a Run that resumed after its completion decision asked for a repair.
 *
 * It is general rather than verification-specific: what it asserts is that a Run which had stopped
 * to have its result decided may keep working. *Which* decision asked for the repair belongs to the
 * layer that made it.
 */
export function resumeAgentRunFromCompletionRepair(run: AgentRun): AgentRun {
  return resumeRunToRunning(run);
}

function resumeRunToRunning(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("resumed Run cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "RUNNING");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "RUNNING" });
}
