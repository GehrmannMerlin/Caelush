import type { RunStatus } from "@caelush/protocol";

import { isTerminalRunStatus } from "./run-execution-invariant.js";

/**
 * The canonical durable Run state machine.
 *
 * ```text
 * a Run status changes only through this table
 * ```
 *
 * It is Agent-owned because a Run status is a statement about the *Run*, not about this host's
 * storage or its coding subsystems: every consumer that could disagree about whether a transition
 * is legal would otherwise become a second authority over the same lifecycle. Core re-exports these
 * symbols rather than declaring them again, so `instanceof` and the table agree everywhere.
 *
 * Two declarations live here and nowhere else:
 *
 * ```text
 * RUN_STATUS_TRANSITIONS   the allowed-transition matrix, one row per status
 * InvalidRunStatusTransitionError   the error a refused transition throws
 * ```
 *
 * The terminal-status predicate is deliberately **not** redeclared: it is the set of statuses with
 * no outgoing transition, and `run-execution-invariant.ts` already owns the one implementation.
 * {@link assertRunStatusTransitionsAreTotal} ties the two together so they cannot drift.
 */

/**
 * The allowed-transition matrix.
 *
 * A row lists exactly the statuses its key may move to. An empty row means the status is settled:
 * nothing may reopen it, and the coordinator routes it to `RETURN_TERMINAL`.
 */
export const RUN_STATUS_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "WAITING_RESOURCE",
    "VERIFYING",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "TIMEOUT"],
  WAITING_RESOURCE: ["RUNNING", "FAILED", "CANCELLED", "TIMEOUT"],
  VERIFYING: ["COMPLETED", "RUNNING", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
  MAX_STEPS_REACHED: [],
  BUDGET_EXCEEDED: [],
};

/** Every status, in canonical order. The matrix must cover exactly these. */
export const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
] as const satisfies readonly RunStatus[];

/** Whether the Run may move from one status to another. */
export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

/** A Run status transition the canonical state machine refuses. */
export class InvalidRunStatusTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid run status transition: ${from} -> ${to}`);
    this.name = "InvalidRunStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Refuse a transition the matrix does not allow. */
export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new InvalidRunStatusTransitionError(from, to);
  }
}

/**
 * Assert the matrix and the terminal predicate describe the same Run lifecycle.
 *
 * The two facts are declared separately on purpose — one is the transitions, the other is the
 * settled set — so the only safe way to keep them from drifting is to state the relationship and
 * check it. A status is settled exactly when it has no outgoing transition.
 */
export function assertRunStatusTransitionsAreTotal(): void {
  for (const status of RUN_STATUSES) {
    const settled = RUN_STATUS_TRANSITIONS[status].length === 0;
    if (settled !== isTerminalRunStatus(status)) {
      throw new Error(
        `Run status "${status}" is ${settled ? "settled" : "open"} in the transition matrix but ${settled ? "open" : "settled"} in the terminal predicate.`,
      );
    }
    for (const target of RUN_STATUS_TRANSITIONS[status]) {
      if (!(target in RUN_STATUS_TRANSITIONS)) {
        throw new Error(
          `Run status transition "${status}" -> "${target}" names an unknown status.`,
        );
      }
    }
  }
}
