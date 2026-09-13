import type {
  AdvanceAgentDirective,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  FinalizeDirective,
  ReturnTerminalDirective,
  RunExecutionDirective,
  RunExecutionFinalization,
  RunExecutionTerminalReason,
  SuspendDirective,
} from "./directive.js";
import type { RunExecutionCoordinator, RunExecutionFacts } from "./snapshot.js";
import type { RunExecutionStatus } from "./directive.js";

/**
 * The durable Run execution coordinator.
 *
 * ```text
 * RunExecutionDirective = what durable execution does next
 * ```
 *
 * It is **pure and deterministic**: the same facts and the same `now` always produce the same
 * directive. It reads no clock, generates no identifier, performs no I/O, touches no store and
 * mints no state. That is what makes every routing rule in the Run Layer testable as a table
 * instead of as an integration test.
 *
 * Governance priority is fixed, highest first:
 *
 * ```text
 * 1  already terminal            the Run is settled; nothing may reopen it
 * 2  durable cancellation intent the first writer wins, over every continuation
 * 3  Run deadline                the original deadline, never an extended one
 * 4  unexpected abort            fatal rather than routable
 * 5  structural step budget      maxSteps, which the AgentLoop must not know about
 * 6  durable boundaries          approval, resource, retry timing, accepted results
 * 7  normal execution            advance, tool batch, completion evaluation
 * ```
 *
 * The ordering is the whole point. A Run that has spent its step budget must not start another
 * turn, a cancelled Run must not resume a retry, and an expired Run must not be given a fresh
 * attempt — each of those is a real recovery bug that a single misordered branch would create.
 */
export function createRunExecutionCoordinator(): RunExecutionCoordinator {
  return {
    next(facts: RunExecutionFacts, now: number): RunExecutionDirective {
      return nextRunExecutionDirective(facts, now);
    },
  };
}

/** The coordination decision, as a pure function so it can be tested directly. */
export function nextRunExecutionDirective(
  facts: RunExecutionFacts,
  now: number,
): RunExecutionDirective {
  /* 1. A settled Run is settled. */
  if (isTerminalExecutionStatus(facts.status)) {
    return terminal(facts.status, "ALREADY_TERMINAL");
  }

  /* 2. Durable cancellation intent outranks every continuation. */
  if (facts.cancellationRequested === true) {
    return finalize({ reason: "CANCELLED" });
  }

  /* 3. The original Run deadline. */
  if (facts.deadlineExceeded === true) {
    return finalize({ reason: "TIMEOUT" });
  }

  /* 4. An abort with no cause is not routable; an abort with the user cause is a cancellation. */
  if (facts.aborted === true) {
    if (facts.abortCause === "USER_REQUESTED") return finalize({ reason: "CANCELLED" });
    if (facts.abortCause === "DEADLINE_EXCEEDED") return finalize({ reason: "TIMEOUT" });
    return terminal(facts.status, "UNEXPECTED_ABORT");
  }

  /* 5. Structural step budget. The AgentLoop has no idea this exists. */
  const budget = maxStepsFinalization(facts);
  if (budget !== undefined) return finalize(budget);

  /* 6. A durable boundary that only an external resolution can move. */
  if (facts.status === "WAITING_APPROVAL") {
    return suspend("APPROVAL");
  }
  if (facts.status === "WAITING_RESOURCE") {
    return suspend("RESOURCE");
  }
  if (facts.status === "PENDING") {
    return advance("START");
  }
  if (facts.status === "VERIFYING") {
    return facts.completionAvailable === false
      ? terminal("VERIFYING", "UNAVAILABLE_VERIFICATION")
      : evaluateCompletion("RECOVER");
  }
  if (facts.status !== "RUNNING") {
    // A status the coordinator does not route is reported, never guessed at.
    return terminal(facts.status, "UNAVAILABLE_BOUNDARY");
  }

  /* 7. Normal RUNNING execution. */
  if (facts.activeStep === true) {
    // A stale RUNNING Step is a durable uncertain boundary. It is never resent to a provider,
    // and it is not a routing decision this coordinator may make on its own.
    return terminal("RUNNING", "MISSING_CONTINUATION");
  }

  switch (facts.continuation) {
    case "WAITING_RETRY": {
      const due = retryDue(facts, now);
      if (due === undefined) return suspend("RETRY_NOT_DUE");
      return advance(due);
    }
    case "WAITING_VERIFICATION_REPAIR":
      return advance("REPAIR");
    case "WAITING_TOOL_RESULTS": {
      if (facts.toolResultsAccepted === true) return advance("TOOLS");
      if (facts.awaitingApproval === true) return suspend("APPROVAL");
      if (facts.toolBatchAvailable === false) {
        return terminal("RUNNING", "TOOL_COORDINATOR_UNAVAILABLE");
      }
      return executeToolBatch("EXECUTE");
    }
    case "WAITING_RESOURCE":
      return suspend("RESOURCE");
    case "AWAITING_VERIFICATION":
      return facts.completionAvailable === false
        ? terminal("RUNNING", "UNAVAILABLE_VERIFICATION")
        : evaluateCompletion("EVALUATE");
    case undefined:
      return advance("START");
    default:
      return terminal("RUNNING", "MISSING_CONTINUATION");
  }
}

/* ------------------------------------------------------------------ helpers */

/** Is this status settled? */
export function isTerminalExecutionStatus(status: RunExecutionStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}

function advance(mode: AdvanceAgentDirective["mode"]): AdvanceAgentDirective {
  return { kind: "ADVANCE_AGENT", mode };
}

function executeToolBatch(mode: ExecuteToolBatchDirective["mode"]): ExecuteToolBatchDirective {
  return { kind: "EXECUTE_TOOL_BATCH", mode };
}

function evaluateCompletion(
  mode: EvaluateCompletionDirective["mode"],
): EvaluateCompletionDirective {
  return { kind: "EVALUATE_COMPLETION", mode };
}

function suspend(reason: SuspendDirective["reason"]): SuspendDirective {
  return { kind: "SUSPEND", reason };
}

function finalize(finalization: RunExecutionFinalization): FinalizeDirective {
  return { kind: "FINALIZE", finalization };
}

function terminal(
  status: ReturnTerminalDirective["status"],
  reason?: RunExecutionTerminalReason,
): ReturnTerminalDirective {
  return reason === undefined
    ? { kind: "RETURN_TERMINAL", status }
    : { kind: "RETURN_TERMINAL", status, reason };
}

/**
 * The structural step-budget decision.
 *
 * The budget counts settled attempts, so the gate is "has the Run already spent its allowance",
 * not "is this the last one": a Run at the limit must be settled rather than given one more
 * turn. Nothing here knows what a model is.
 */
function maxStepsFinalization(facts: RunExecutionFacts): RunExecutionFinalization | undefined {
  const maxSteps = facts.maxSteps;
  const stepsCompleted = facts.stepsCompleted;
  if (maxSteps === undefined || stepsCompleted === undefined) return undefined;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) return undefined;
  if (!Number.isSafeInteger(stepsCompleted) || stepsCompleted < 0) return undefined;
  if (stepsCompleted < maxSteps) return undefined;
  return { reason: "MAX_STEPS_REACHED", stepsCompleted, maxSteps };
}

/**
 * Which execution mode a due retry resumes with.
 *
 * A retry that failed while a Tool turn was open must resume *with* the accepted results, and a
 * retry that failed before any Tool existed must start a fresh turn. Getting this backwards
 * would either duplicate a batch or drop one.
 */
function retryDue(
  facts: RunExecutionFacts,
  now: number,
): AdvanceAgentDirective["mode"] | undefined {
  const nextAttemptAt = facts.retryNextAttemptAt;
  if (nextAttemptAt === undefined) return undefined;
  if (now < nextAttemptAt) return undefined;
  return facts.retryResumesToolResults === true ? "TOOLS" : "START";
}
