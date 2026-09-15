import type { AgentRun, AgentState, TimestampMs } from "@caelush/protocol";
import { AgentStateSchema } from "@caelush/protocol";
import { AgentKernelStateError } from "./agent-errors.js";
import { assertRunStatusTransition } from "./run-state-machine.js";
import { assertMonotonicAgentStateTimestamp } from "@caelush/agent";

/**
 * The AgentState facade.
 *
 * ```text
 * general       @caelush/agent   the transitions any Run Layer performs on an AgentState
 * creation      this file        how *this* host opens a Run's first state
 * verification  this file        the boundary a completion decision is asked at
 * ```
 *
 * Phase 3C moved every general AgentState transition into the kernel, because an AgentState status
 * change is a statement about the *Run*. The re-exports below are a compatibility surface, not a
 * second implementation: there is exactly one `markAgentStateTimedOut` and one `completeAgentState`,
 * and Core names them the way its existing call sites already do.
 *
 * What stays here is genuinely this host's: the shape of a Run's first state, how a Run is started,
 * and the one resume that is phrased in terms of a completion decision.
 */

export {
  completeAgentState as markAgentStateCompleted,
  markAgentStateBudgetExceeded,
  markAgentStateCancelled,
  markAgentStateFailed,
  markAgentStateMaxStepsReached,
  markAgentStateTimedOut,
  markAgentStateVerifying,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  resumeAgentStateFromApproval,
  resumeAgentStateFromResource,
} from "@caelush/agent";

/**
 * The AgentState projection of the active durable Step, re-exported from the kernel.
 *
 * Phase 3C moved the canonical implementation into `@caelush/agent`'s Run Layer. The functions
 * stayed exported from here because the Run Layer already imports them by name; a re-export is a
 * compatibility surface, not a second implementation.
 */
export { beginAgentStepState, cancelAgentStepState, settleAgentStepState } from "@caelush/agent";
export type { CancelAgentStepStateInput, SettleAgentStepInput } from "@caelush/agent";

/** The initial AgentState of a PENDING Run. */
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

/** The AgentState of a Run that started executing. */
export function startAgentState(state: AgentState, now: TimestampMs): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
  assertRunStatusTransition(state.status, "RUNNING");
  return AgentStateSchema.parse({ ...state, status: "RUNNING", startedAt: now, updatedAt: now });
}

/**
 * The AgentState that resumed after its completion decision asked for a repair.
 *
 * Phrased in terms of the decision that caused it, which is why it stays with the layer that makes
 * that decision rather than moving into the kernel with the other resumes.
 */
export function resumeAgentStateFromVerificationRepair(
  state: AgentState,
  now: TimestampMs,
): AgentState {
  assertMonotonicAgentStateTimestamp(state, now);
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
