import { isTerminalRunStatus } from "@caelush/core";
import type { AgentRun, RunId } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";

import type {
  RunExecutionSupervisor,
  RunExecutionSupervisorLogger,
} from "./run-execution-supervisor.js";

/**
 * Fresh-daemon stale-Run reconciliation.
 *
 * ```text
 * a daemon starts
 *   → enumerate the Runs a previous generation left non-terminal
 *   → hand each one to the *existing* recovery authority
 *   → never invent a second state machine
 * ```
 *
 * ## Why this is the missing half, and not a new mechanism
 *
 * `RunController.recover()` already knows how to settle a stale Step fail-closed, resume a durable
 * tool queue, restore an approval or resource wait and re-enter the verification loop.
 * `RunExecutionSupervisor.recover()` already owns the scheduling dispositions. What did not exist was
 * anything that *asked*: a Run whose daemon was killed stayed `RUNNING` forever, because nothing ever
 * enumerated it on the next boot. This module is that enumeration and nothing else.
 *
 * ## What it deliberately does not do
 *
 * ```text
 * PENDING            never started, so never reconciled; starting is a user action
 * terminal           COMPLETED / FAILED / CANCELLED / TIMEOUT / MAX_STEPS_REACHED / BUDGET_EXCEEDED
 *                    are settled forever and are never reopened
 * WAITING_APPROVAL   recovery restores the *same* wait; it never approves for the user
 * WAITING_RESOURCE   same
 * ```
 *
 * A side-effectful Tool is never replayed. A stale active Step is a durable *uncertain* boundary,
 * and the recovery path settles it that way rather than re-running it — which is the entire reason
 * this routes through the RunController instead of re-driving the Run from the top.
 *
 * ## Failure isolation
 *
 * One Run that cannot be scheduled must not stop the others, and must not stop the daemon from
 * serving. Every failure is recorded and reported to the optional logger; the returned summary is
 * the evidence.
 */
export interface StartupReconciliationOptions {
  readonly runs: Pick<RunRepository, "listRecoverable">;
  readonly supervisor: Pick<RunExecutionSupervisor, "recover">;
  /** The bounded enumeration size; the repository default applies when omitted. */
  readonly limit?: number;
  readonly logger?: RunExecutionSupervisorLogger;
}

export interface StartupReconciliationSummary {
  /** How many Runs the bounded enumeration returned. */
  readonly examined: number;
  /** Runs whose recovery was handed to the supervisor as a background operation. */
  readonly scheduled: readonly RunId[];
  /** Runs that already had a live execution driver; nothing was scheduled twice. */
  readonly alreadyActive: readonly RunId[];
  /** Runs that turned out to be terminal by the time they were examined; never reopened. */
  readonly noopTerminal: readonly RunId[];
  /** Runs whose recovery could not even be scheduled. */
  readonly failed: readonly RunId[];
}

export async function reconcileStaleRuns(
  options: StartupReconciliationOptions,
): Promise<StartupReconciliationSummary> {
  const stale = await options.runs.listRecoverable(
    options.limit === undefined ? {} : { limit: options.limit },
  );
  const scheduled: RunId[] = [];
  const alreadyActive: RunId[] = [];
  const noopTerminal: RunId[] = [];
  const failed: RunId[] = [];

  for (const run of stale) {
    if (!isReconcilable(run)) continue;
    try {
      const result = await options.supervisor.recover(run.id);
      if (result.disposition === "ALREADY_ACTIVE") alreadyActive.push(run.id);
      else if (result.disposition === "NOOP_TERMINAL") noopTerminal.push(run.id);
      else scheduled.push(run.id);
    } catch (error) {
      failed.push(run.id);
      reportFailure(options.logger, error, run.id);
    }
  }

  return {
    examined: stale.length,
    scheduled,
    alreadyActive,
    noopTerminal,
    failed,
  };
}

/**
 * Second, independent guard against reconciling something that must not be reconciled.
 *
 * The repository query already filters to `RECOVERABLE_RUN_STATUSES`, but a query is a filter and
 * this is an invariant. The two are deliberately not the same check: the statuses live in Storage so
 * the enumeration can be a real `WHERE`, and the rule that a non-recoverable Run must never be handed
 * to a recovery authority lives here, next to the authority that would be wrong to call.
 */
function isReconcilable(run: AgentRun): boolean {
  if (run.status === "PENDING") return false;
  return !isTerminalRunStatus(run.status);
}

function reportFailure(
  logger: RunExecutionSupervisorLogger | undefined,
  error: unknown,
  runId: RunId,
): void {
  try {
    logger?.error?.(error, { operation: "STARTUP_RECONCILE", runId });
  } catch {
    // Logging must not turn a handled reconciliation failure into a startup failure.
  }
}
