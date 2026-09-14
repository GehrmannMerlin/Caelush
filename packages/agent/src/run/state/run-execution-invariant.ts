import type { RunStatus } from "@caelush/protocol";

import type { RunExecutionSnapshot } from "../ports/run-execution-store.js";
import { RunExecutionInvariantError } from "../ports/run-execution-store.js";

/**
 * The general durable Run execution invariant.
 *
 * One snapshot must describe one coherent Run: the Run and its AgentState are two projections of
 * the same fact, an active Step is referenced by both or by neither, and a continuation is legal
 * for the status that holds it. A snapshot that disagrees with itself is a durable-record
 * corruption, so this throws rather than repairing anything.
 *
 * Deliberately absent: the coding-verification clauses. A `VerificationPlan` and a
 * `VerifiedRunFinalResult` are not general Run concepts, and a host that needs them asserts them
 * in its own compatibility layer instead of widening this contract.
 */
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
    if (continuation?.type !== "AWAITING_VERIFICATION" || run.finalResult !== undefined) {
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
    if (continuation?.type === "WAITING_RESOURCE" && activeStep !== undefined) {
      throw new RunExecutionInvariantError("WAITING_RESOURCE Run cannot retain an active Step");
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
      throw new RunExecutionInvariantError("WAITING_RESOURCE Run must retain a resource boundary");
    }
  } else if (continuation !== undefined) {
    throw new RunExecutionInvariantError(`${run.status} Run cannot retain a continuation`);
  }
}

/** Whether a Run status is settled and may never be reopened. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}
