import type {
  RunExecutionBudgetBlock,
  RunExecutionContinuationKind,
  RunExecutionErrorCode,
  RunExecutionStatus,
} from "./directive.js";

/**
 * What the coordinator is allowed to know.
 *
 * This is deliberately a *fact* type rather than a storage snapshot: it holds exactly the
 * discriminants the routing decision needs, and none of the durable payload a commit carries.
 *
 * ```text
 * RunExecutionSnapshot (storage)   the durable row, with AgentRun, AgentState and the payload
 * RunExecutionFacts     (this type) the routing discriminants, and nothing else
 * ```
 *
 * The separation is what makes determinism testable: a coordinator that received the whole
 * snapshot could quietly start reading a timestamp, a token count or a message array, and the
 * "same facts + same now -> same directive" property would stop being true in practice.
 */
export interface RunExecutionFacts {
  readonly runId: string;
  readonly status: RunExecutionStatus;
  /** The durable continuation discriminant, when the Run has one. */
  readonly continuation?: RunExecutionContinuationKind;
  /** True while the continuation already carries an approval pointer. */
  readonly awaitingApproval?: boolean;
  /** True while the continuation already carries accepted Tool Results. */
  readonly toolResultsAccepted?: boolean;
  /** True when a durable Step is active and has not been settled. */
  readonly activeStep?: boolean;
  /** Settled Agent Step attempts so far. */
  readonly stepsCompleted?: number;
  /** The structural step budget. */
  readonly maxSteps?: number;
  /**
   * When a `WAITING_RETRY` boundary becomes due.
   *
   * The coordinator compares it with the `now` it was given and decides *whether* to resume. It
   * never schedules anything: arming a timer, sleeping and backing off are Run Layer actions,
   * and an AgentLoop that slept would be a second retry authority.
   */
  readonly retryNextAttemptAt?: number;
  /**
   * Whether the failed attempt had an open Tool turn with accepted results.
   *
   * A retry with accepted results must resume *with* them; a retry without must start a fresh
   * turn. The coordinator reports which, and the driver preserves the results either way.
   */
  readonly retryResumesToolResults?: boolean;
  /** The Run has a durable cancelled intent, which outranks every other continuation. */
  readonly cancellationRequested?: boolean;
  /** The active execution scope is aborted, with the in-memory cause when known. */
  readonly aborted?: boolean;
  readonly abortCause?: "USER_REQUESTED" | "DEADLINE_EXCEEDED";
  /** The original Run deadline has passed. */
  readonly deadlineExceeded?: boolean;
  /** Whether a Tool batch boundary is even executable in this composition. */
  readonly toolBatchAvailable?: boolean;
  /** Whether completion evaluation is even executable in this composition. */
  readonly completionAvailable?: boolean;
}

/** The frozen coordinator contract. */
export interface RunExecutionCoordinator {
  next(facts: RunExecutionFacts, now: number): import("./directive.js").RunExecutionDirective;
}

export type {
  RunExecutionBudgetBlock,
  RunExecutionContinuationKind,
  RunExecutionErrorCode,
  RunExecutionStatus,
};
