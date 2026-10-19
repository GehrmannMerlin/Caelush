import type { StepId } from "@caelush/protocol";

/**
 * The durable Run input facts one execution decision is made from.
 *
 * ```text
 * Run Input     a user's mid-Run text correction, durably accepted for exactly one Run
 * USER record   the canonical conversation message it becomes
 * Step          the prepared model turn that first included that message
 * ```
 *
 * The three are separate facts and the contract keeps them separate: acceptance is not a
 * conversation message, and a conversation message is not proof that a model request carried it.
 *
 * The snapshot carries only a **bounded prefix** of pending text — enough for one safe boundary to
 * materialize — plus counts. A Run with a thousand accepted inputs must not make every snapshot
 * unbounded, and the counts are what protect completion from a queue the batch limit did not drain.
 */

/** One not-yet-recorded input, as a boundary needs it. */
export interface PendingRunInput {
  readonly inputId: string;
  /** Run-local FIFO order. Never a client timestamp and never an event sequence. */
  readonly acceptedSequence: number;
  /** Normalized text, exactly as it will become the canonical USER message. */
  readonly text: string;
}

/** One input whose canonical USER message exists but whose first model step was never opened. */
export interface RecordedRunInput {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly messageId: string;
}

/** The Run input facts of one durable snapshot. */
export interface RunInputSnapshot {
  /** PENDING inputs in `acceptedSequence` order, bounded by the batch limit. */
  readonly pending: readonly PendingRunInput[];
  /**
   * RECORDED inputs in `acceptedSequence` order.
   *
   * They are carried into the next prepared turn so their first-Step association can be written,
   * which is why they are bounded by the backlog cap rather than by the batch cap.
   */
  readonly recorded: readonly RecordedRunInput[];
  /** Total PENDING inputs, which may exceed `pending.length`. */
  readonly pendingCount: number;
  /** Inputs already recorded as canonical USER messages but not yet part of a model step. */
  readonly recordedCount: number;
  /** `pendingCount + recordedCount`: every input a normal completion must not skip. */
  readonly unassignedCount: number;
}

/** One input a handoff materializes into a canonical USER message. */
export interface RunInputHandoffEntry {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly messageId: string;
}

/**
 * T2: the inputs this transaction records and the USER messages it writes.
 *
 * The store verifies every entry is still PENDING for this Run, at the sequence the caller froze,
 * and writes the mapping in the same transaction as the message records. There is deliberately no
 * separate `markRecorded`: a mapping written in its own transaction could survive a failed message
 * append, and a message could survive without its mapping.
 */
export interface RunInputHandoff {
  readonly entries: readonly RunInputHandoffEntry[];
}

/**
 * T3: the inputs whose messages were part of the model step this transaction opens.
 *
 * Only messages the prepared request actually carried may be listed; a Context selection that
 * dropped one leaves it `RECORDED`, which is a truthful state rather than a false claim.
 */
export interface RunInputAssignment {
  readonly stepId: StepId;
  readonly messageIds: readonly string[];
}

/** The Run input writes one atomic execution commit may carry. */
export interface RunInputCommit {
  /** The commit's own timestamp, used for the handoff/assignment audit columns. */
  readonly now: number;
  readonly handoff?: RunInputHandoff;
  readonly assignment?: RunInputAssignment;
}
