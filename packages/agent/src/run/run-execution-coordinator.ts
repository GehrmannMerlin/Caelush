import type { StepId, TimestampMs } from "@caelush/protocol";

import type { AgentTurnInput } from "../loop/types.js";
import type {
  AdvanceAgentDirective,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  FinalizeDirective,
  RunExecutionAdvanceReason,
  RunExecutionDirective,
  RunExecutionFinalizeReason,
  RunExecutionMode,
  RunExecutionSuspendBoundary,
  SuspendDirective,
} from "./directive.js";
import { isTerminalExecutionStatus } from "./directive.js";
import type { RunExecutionSnapshot } from "./ports/run-execution-store.js";
import { RunExecutionInvariantError } from "./ports/run-execution-store.js";

/**
 * The durable Run execution coordinator.
 *
 * ```text
 * RunExecutionDirective = what durable execution does next
 * ```
 *
 * It is **pure and deterministic**: the same snapshot and the same `now` always produce the same
 * directive. It reads no clock, generates no identifier, performs no I/O, touches no store and
 * mints no state — which is what makes every routing rule testable as a table.
 *
 * Governance priority is fixed, highest first:
 *
 * ```text
 * 1  already terminal             the Run is settled; nothing may reopen it
 * 2  durable cancellation intent  the first writer wins, over every continuation
 * 3  Run deadline                 the original deadline, never an extended one
 * 4  structural step budget       maxSteps, which the AgentLoop must not know about
 * 5  durable boundaries           approval, resource, retry timing, accepted results
 * 6  normal execution             advance, Tool batch, completion evaluation
 * ```
 *
 * The ordering is the point. A Run that has spent its step budget must not start another turn, a
 * cancelled Run must not resume a retry, and an expired Run must not be given a fresh attempt —
 * each of those is a real recovery bug that one misordered branch would create.
 *
 * A state the coordinator cannot route is **not** guessed at. It throws: an active Step it should
 * never have been shown, a status it has no rule for, a continuation it cannot interpret.
 * Reporting one as a terminal result would hide a lifecycle violation inside a successful answer.
 */
export interface RunExecutionCoordinator {
  next(snapshot: RunExecutionSnapshot, now: TimestampMs): RunExecutionDirective;
}

/** Create the frozen coordinator. */
export function createRunExecutionCoordinator(): RunExecutionCoordinator {
  return {
    next(snapshot: RunExecutionSnapshot, now: TimestampMs): RunExecutionDirective {
      return nextRunExecutionDirective(snapshot, now);
    },
  };
}

/** The coordination decision, as a pure function so it can be tested directly. */
export function nextRunExecutionDirective(
  snapshot: RunExecutionSnapshot,
  now: TimestampMs,
): RunExecutionDirective {
  const { run, state } = snapshot;

  /* 1. A settled Run is settled. */
  if (isTerminalExecutionStatus(run.status)) return { kind: "RETURN_TERMINAL" };

  /* 2. Durable cancellation intent outranks every continuation. */
  if (snapshot.cancellationIntent !== undefined) return finalize("CANCELLED");

  /* 3. The original Run deadline. */
  if (deadlineExceeded(snapshot, now)) return finalize("TIMEOUT");

  /* 4. An active Step is a boundary the caller must settle before routing. */
  if (snapshot.activeStep !== undefined) {
    throw new RunExecutionInvariantError(
      "A Run with an active Step cannot be routed: the Step must be settled first.",
    );
  }

  /* 5. Structural step budget. The AgentLoop has no idea this exists. */
  if (state !== undefined && state.usage.steps >= run.limits.maxSteps) {
    return finalize("MAX_STEPS_REACHED");
  }

  /* 6. Durable boundaries, then normal execution. */
  switch (run.status) {
    case "PENDING":
      return advance("EXECUTE", "INITIAL", initialTurn(snapshot));
    case "WAITING_APPROVAL":
      return suspend("APPROVAL");
    case "WAITING_RESOURCE":
      return suspend("RESOURCE");
    case "VERIFYING":
      return evaluateCompletion("RECOVER", snapshot);
    case "RUNNING":
      return routeRunning(snapshot, now);
    default:
      throw new RunExecutionInvariantError(`Run status "${run.status}" has no execution rule.`);
  }
}

/* --------------------------------------------------------------- RUNNING */

function routeRunning(snapshot: RunExecutionSnapshot, now: TimestampMs): RunExecutionDirective {
  const continuation = snapshot.continuation;
  if (continuation === undefined) {
    // Nothing durable is open. A Run with no conversation at all is starting its first Reason; a
    // Run that already has one has finished a turn without leaving a boundary, which is a
    // lifecycle violation rather than something to route around.
    return isInitialDurableUserTurn(snapshot)
      ? advance("EXECUTE", "INITIAL", initialTurn(snapshot))
      : throwUnroutable("A RUNNING Run with no continuation cannot be routed.");
  }

  switch (continuation.type) {
    case "WAITING_TOOL_RESULTS":
      if (continuation.waitingApproval !== undefined) return suspend("APPROVAL");
      if (continuation.receivedResults !== undefined) {
        return advance("RECOVER", "TOOL_RESULTS", {
          kind: "TOOL_RESULTS",
          sourceStepId: continuation.sourceStepId,
          pendingDecision: continuation.pendingDecision,
          results: continuation.receivedResults,
        });
      }
      return toolBatch("EXECUTE", {
        sourceStepId: continuation.sourceStepId,
        pendingDecision: continuation.pendingDecision,
        ...(continuation.observationPolicy === undefined
          ? {}
          : { observationPolicy: continuation.observationPolicy }),
      });
    case "WAITING_VERIFICATION_REPAIR":
      return advance("RECOVER", "COMPLETION_REPAIR", {
        kind: "CONTINUATION",
        reason: "VERIFICATION_REPAIR",
      });
    case "WAITING_RESOURCE":
      return suspend("RESOURCE");
    case "WAITING_RETRY":
      if (now < continuation.nextAttemptAt) return suspend("RETRY", continuation.nextAttemptAt);
      if (continuation.mode === "TOOL_RESULTS") {
        // The RunController resolves a legacy checkpoint from the durable ledger before routing.
        // Reaching here without one means it could not, and fabricating a Step identity is not an
        // acceptable answer.
        const sourceStepId: StepId | undefined = continuation.sourceStepId;
        if (sourceStepId === undefined) {
          throw new RunExecutionInvariantError(
            "A retry Tool resume has no recorded request Step and cannot be routed.",
          );
        }
        return advance("RECOVER", "RETRY", {
          kind: "TOOL_RESULTS",
          sourceStepId,
          pendingDecision: continuation.pendingDecision,
          results: continuation.receivedResults,
        });
      }
      return advance("RECOVER", "RETRY", initialTurn(snapshot));
    case "AWAITING_VERIFICATION":
      // A verification boundary held by a RUNNING Run is a lifecycle violation: the Run should be
      // VERIFYING. Routing it would let a Run hold a candidate and keep reasoning at once.
      return throwUnroutable("A RUNNING Run cannot hold an AWAITING_VERIFICATION boundary.");
    default:
      return throwUnroutable("Run continuation has no execution rule.");
  }
}

/**
 * The turn a fresh — or freshly retried — Reason starts from.
 *
 * `AgentRun.goal` is the durable statement the Run was created with, and the Run Layer is what
 * projects it into the first user message. The Agent Loop never does this: it receives an explicit
 * `USER_INPUT` and must not derive one from `identity.goal`, which is exactly why the projection
 * belongs here, in the Run Layer.
 */
function initialTurn(snapshot: RunExecutionSnapshot): AgentTurnInput {
  return { kind: "USER_INPUT", messages: [{ role: "user", content: snapshot.run.goal }] };
}

function isInitialDurableUserTurn(snapshot: RunExecutionSnapshot): boolean {
  const conversationRecords = snapshot.conversationRecords ?? [];
  if (conversationRecords.length !== 1) return false;
  const record = conversationRecords[0];
  return (
    record?.messageType === "USER" &&
    record.source.kind === "USER" &&
    record.source.origin !== "STEERING"
  );
}

/* ----------------------------------------------------------- derivations */

/**
 * Whether the Run's original deadline has passed.
 *
 * A PENDING Run has no active deadline. The deadline is `startedAt + limits.timeoutMs` — never
 * `createdAt`, and never a refreshed `now`.
 *
 * The comparison is written as a difference rather than as a sum, and that is deliberate. A host
 * may configure an effectively unbounded deadline — the local daemon uses a safe-integer ceiling —
 * and `startedAt + timeoutMs` then exceeds the safe-integer range even though every input is a
 * safe integer. Forming that sum would have to fail, and failing would make the Run unroutable for
 * a configuration that is perfectly well defined. `now - startedAt >= timeoutMs` is the same
 * predicate, exact for every safe input, and never forms a value that cannot be represented.
 */
function deadlineExceeded(snapshot: RunExecutionSnapshot, now: TimestampMs): boolean {
  const timeoutMs = snapshot.run.limits.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RunExecutionInvariantError("Run timeoutMs must be a safe positive integer.");
  }
  const startedAt = snapshot.state?.startedAt ?? snapshot.run.startedAt;
  if (startedAt === undefined) return false;
  return now - startedAt >= timeoutMs;
}

/* -------------------------------------------------------------- builders */

function advance(
  mode: RunExecutionMode,
  reason: RunExecutionAdvanceReason,
  input: AgentTurnInput,
): AdvanceAgentDirective {
  return { kind: "ADVANCE_AGENT", mode, reason, input };
}

function toolBatch(
  mode: RunExecutionMode,
  payload: Pick<
    ExecuteToolBatchDirective,
    "sourceStepId" | "pendingDecision" | "observationPolicy"
  >,
): ExecuteToolBatchDirective {
  return { kind: "EXECUTE_TOOL_BATCH", mode, ...payload };
}

function suspend(boundary: RunExecutionSuspendBoundary, resumeAt?: TimestampMs): SuspendDirective {
  return resumeAt === undefined
    ? { kind: "SUSPEND", boundary }
    : { kind: "SUSPEND", boundary, resumeAt };
}

function finalize(reason: RunExecutionFinalizeReason): FinalizeDirective {
  return { kind: "FINALIZE", reason };
}

function evaluateCompletion(
  mode: RunExecutionMode,
  snapshot: RunExecutionSnapshot,
): EvaluateCompletionDirective {
  const continuation = snapshot.continuation;
  if (continuation?.type !== "AWAITING_VERIFICATION") {
    throw new RunExecutionInvariantError(
      "A VERIFYING Run must hold an AWAITING_VERIFICATION boundary.",
    );
  }
  return {
    kind: "EVALUATE_COMPLETION",
    mode,
    sourceStepId: continuation.sourceStepId,
    candidate: continuation.finalDecision,
  };
}

function throwUnroutable(message: string): never {
  throw new RunExecutionInvariantError(message);
}
