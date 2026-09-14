import {
  AgentErrorSchema,
  AgentRunSchema,
  AgentStateSchema,
  VerifiedRunFinalResultSchema,
  type AgentError,
  type AgentRun,
  type AgentState,
  type RunStatus,
} from "@caelush/protocol";
import { assertRunExecutionInvariant as assertGeneralRunExecutionInvariant } from "@caelush/agent";
import type { RunExecutionSnapshotView } from "./run-execution-store.js";
import { RunExecutionInvariantError } from "./run-execution-store.js";
import { assertRunStatusTransition, isTerminalRunStatus } from "./run-state-machine.js";

export function markAgentStateFailed(
  state: AgentState,
  error: AgentError,
  now: AgentState["updatedAt"],
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

export function markAgentRunFailed(run: AgentRun, now: AgentRun["createdAt"]): AgentRun {
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

export function markAgentRunCancelled(run: AgentRun, now: AgentRun["createdAt"]): AgentRun {
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

export function markAgentRunTimedOut(run: AgentRun, now: AgentRun["createdAt"]): AgentRun {
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

export function markAgentRunBudgetExceeded(run: AgentRun, now: AgentRun["createdAt"]): AgentRun {
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

export function markAgentRunCompleted(
  run: AgentRun,
  finalResult: AgentRun["finalResult"],
  now: AgentRun["createdAt"],
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
    finalResult: VerifiedRunFinalResultSchema.parse(finalResult),
  });
}

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

export function resumeAgentRunFromResource(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("resource-resumed Run cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "RUNNING");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "RUNNING" });
}

export function resumeAgentRunFromApproval(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("approval-resumed Run cannot retain an active Step");
  }
  assertRunStatusTransition(run.status, "RUNNING");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "RUNNING" });
}

export function resumeAgentRunFromVerificationRepair(run: AgentRun): AgentRun {
  if (run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError(
      "verification-repair-resumed Run cannot retain an active Step",
    );
  }
  assertRunStatusTransition(run.status, "RUNNING");
  const withoutFinalResult = { ...run };
  delete withoutFinalResult.finalResult;
  delete withoutFinalResult.finishedAt;
  return AgentRunSchema.parse({ ...withoutFinalResult, status: "RUNNING" });
}

/**
 * The Run execution invariant, in two halves.
 *
 * ```text
 * general       @caelush/agent   one snapshot describes one coherent Run
 * verification  this file        a VERIFYING Run is bound to the plan it is actually verifying
 * ```
 *
 * The split is what keeps a coding artefact out of the general Run domain: the kernel asserts
 * everything that is true of any Run, and this layer adds only the clause that needs a
 * `VerificationPlan` to state.
 */
export function assertRunExecutionInvariant(snapshot: RunExecutionSnapshotView): void {
  assertGeneralRunExecutionInvariant(snapshot);
  assertVerificationExecutionInvariant(snapshot);
}

/** The coding-verification clause: a VERIFYING Run must be bound to its own plan. */
function assertVerificationExecutionInvariant(snapshot: RunExecutionSnapshotView): void {
  const { run, continuation } = snapshot;
  if (run.status !== "VERIFYING") return;
  if (
    continuation?.type !== "AWAITING_VERIFICATION" ||
    snapshot.verificationPlan === undefined ||
    snapshot.verificationPlan.id !== continuation.verificationPlanId ||
    snapshot.verificationPlan.runId !== run.id ||
    snapshot.verificationPlan.sourceStepId !== continuation.sourceStepId
  ) {
    throw new RunExecutionInvariantError("VERIFYING Run must retain a verification candidate");
  }
}
export function isExecutionBoundaryStatus(status: RunStatus): boolean {
  return (
    status === "PENDING" ||
    status === "RUNNING" ||
    status === "WAITING_APPROVAL" ||
    status === "WAITING_RESOURCE" ||
    status === "VERIFYING" ||
    isTerminalRunStatus(status)
  );
}
