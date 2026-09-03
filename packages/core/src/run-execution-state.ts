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
import type { RunExecutionSnapshot } from "./run-execution-store.js";
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

export function assertRunExecutionInvariant(snapshot: RunExecutionSnapshot): void {
  const { run, state, activeStep, continuation } = snapshot;
  if (run.status === "PENDING") {
    if (
      state !== undefined ||
      run.currentStepId !== undefined ||
      activeStep !== undefined ||
      continuation !== undefined
    ) {
      throw new RunExecutionInvariantError("PENDING Run has durable execution state");
    }
    return;
  }
  if (state === undefined) {
    if (
      run.status === "CANCELLED" &&
      run.currentStepId === undefined &&
      activeStep === undefined &&
      continuation === undefined
    ) {
      return;
    }
    throw new RunExecutionInvariantError("non-PENDING Run has no AgentState");
  }
  if (run.status !== state.status || run.id !== state.runId || run.sessionId !== state.sessionId) {
    throw new RunExecutionInvariantError("Run and AgentState projections are not synchronized");
  }
  if (run.currentStepId !== state.currentStepId) {
    throw new RunExecutionInvariantError("Run and AgentState active Step IDs are not synchronized");
  }
  if (run.currentStepId === undefined && activeStep !== undefined) {
    throw new RunExecutionInvariantError("snapshot contains an unreferenced active Step");
  }
  if (run.currentStepId !== undefined) {
    if (activeStep === undefined || activeStep.id !== run.currentStepId) {
      throw new RunExecutionInvariantError("Run active Step is missing or mismatched");
    }
    if (activeStep.status !== "RUNNING") {
      throw new RunExecutionInvariantError("Run active Step is not RUNNING");
    }
  }
  if (isTerminalRunStatus(run.status) && run.currentStepId !== undefined) {
    throw new RunExecutionInvariantError("terminal Run cannot retain an active Step");
  }
  if (run.status === "COMPLETED") {
    if (run.finishedAt === undefined || run.finalResult === undefined) {
      throw new RunExecutionInvariantError("COMPLETED Run needs finishedAt and finalResult");
    }
    VerifiedRunFinalResultSchema.parse(run.finalResult);
    if (state.status !== "COMPLETED" || state.verification !== "PASSED") {
      throw new RunExecutionInvariantError("COMPLETED Run needs a passed AgentState");
    }
    if (continuation !== undefined) {
      throw new RunExecutionInvariantError("COMPLETED Run cannot retain a continuation");
    }
  } else if (run.finalResult !== undefined) {
    throw new RunExecutionInvariantError("only COMPLETED Run may retain finalResult");
  }
  if (run.status === "VERIFYING") {
    if (
      continuation?.type !== "AWAITING_VERIFICATION" ||
      run.finalResult !== undefined ||
      snapshot.verificationPlan === undefined ||
      snapshot.verificationPlan.id !== continuation.verificationPlanId ||
      snapshot.verificationPlan.runId !== run.id ||
      snapshot.verificationPlan.sourceStepId !== continuation.sourceStepId
    ) {
      throw new RunExecutionInvariantError("VERIFYING Run must retain a verification candidate");
    }
  } else if (run.status === "RUNNING") {
    if (
      continuation !== undefined &&
      continuation.type !== "WAITING_TOOL_RESULTS" &&
      continuation.type !== "WAITING_RESOURCE" &&
      continuation.type !== "WAITING_RETRY" &&
      continuation.type !== "WAITING_VERIFICATION_REPAIR"
    ) {
      throw new RunExecutionInvariantError("RUNNING Run has an invalid continuation");
    }
    if (continuation?.type === "WAITING_RETRY" && activeStep !== undefined) {
      throw new RunExecutionInvariantError("WAITING_RETRY Run cannot retain an active Step");
    }
    if (continuation?.type === "WAITING_VERIFICATION_REPAIR" && activeStep !== undefined) {
      throw new RunExecutionInvariantError(
        "WAITING_VERIFICATION_REPAIR Run cannot retain an active Step",
      );
    }
    if (
      continuation?.type === "WAITING_TOOL_RESULTS" &&
      continuation.waitingApproval !== undefined
    ) {
      throw new RunExecutionInvariantError("RUNNING Run cannot retain an approval pointer");
    }
  } else if (run.status === "WAITING_APPROVAL") {
    if (
      continuation?.type !== "WAITING_TOOL_RESULTS" ||
      continuation.waitingApproval === undefined ||
      continuation.receivedResults !== undefined
    ) {
      throw new RunExecutionInvariantError(
        "WAITING_APPROVAL Run must retain a pending Tool approval boundary",
      );
    }
  } else if (run.status === "WAITING_RESOURCE") {
    if (continuation?.type !== "WAITING_RESOURCE") {
      throw new RunExecutionInvariantError(
        "WAITING_RESOURCE Run must retain a resource guard continuation",
      );
    }
  } else if (continuation !== undefined) {
    throw new RunExecutionInvariantError(`${run.status} Run cannot retain a continuation`);
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
