import type {
  AgentRun,
  AgentState,
  AgentStep,
  DurableRunEvent,
  RunCancellationIntent,
  RunId,
  TimestampMs,
  AttachmentId,
} from "@caelush/protocol";

import type { RunContinuationCheckpoint } from "../continuation/continuation.js";
import type { PrivateReplayWrite } from "../../messages/private-replay.js";
import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type {
  AgentMessageRecord,
  AgentMessageRecordDraft,
} from "../../messages/persistence/record.js";
import type { RunInputCommit, RunInputSnapshot } from "./run-input.js";

/**
 * The canonical Run execution store port.
 *
 * ```text
 * @caelush/agent      owns the contract
 * @caelush/storage    implements it, as an outer adapter
 * ```
 *
 * The direction is one-way and stays one-way: the agent package must never import a storage
 * package, and a Run Layer that could reach into SQLite would be a Run Layer able to disagree
 * with its own contract. What the agent owns is the *shape* of the durable record; who writes the
 * bytes is somebody else's job.
 *
 * Deliberately absent:
 *
 * ```text
 * VerificationPlan / VerifiedRunFinalResult     a coding-verification concern, not a general one
 * provider-facing AI message arrays              compatibility projections, never durable state
 * rows, SQL, Drizzle clients, database handles
 * ```
 *
 * A host that needs a verification-specific commit composes an extension port of its own; the
 * general contract must not grow a field only one subsystem can satisfy.
 */

/** @deprecated Use DurableRunEventDraft. */
export type DurableEventDraft = DurableRunEventDraft;

/** @deprecated Use DurableRunEvent. */
export type DurableAgentEvent = DurableRunEvent;

/**
 * The durable Run state one execution decision is made from.
 *
 * It carries the Run, its AgentState, the active Step, the conversation and the continuation —
 * exactly what a coordinator needs to decide what happens next and what a planner needs to
 * describe the transition. It carries no repository, no client and no row.
 */
export interface RunExecutionSnapshot {
  readonly run: AgentRun;
  readonly state?: AgentState;
  readonly stateRevision?: number;
  /** A Step that was committed as RUNNING and not yet settled. */
  readonly activeStep?: AgentStep;
  /**
   * Whether the durable event log contains `llm.started` for the active Step. False proves recovery
   * stopped before provider I/O; true means the provider turn may have had an external effect. An
   * absent value is unknown and must fail closed.
   */
  readonly activeStepProviderStarted?: boolean;
  readonly conversationRecords: readonly AgentMessageRecord[];
  readonly continuation?: RunContinuationCheckpoint;
  readonly continuationRevision?: number;
  readonly cancellationIntent?: RunCancellationIntent;
  /**
   * Durably accepted mid-Run user text this Run has not applied yet.
   *
   * Absent means "no intake store is composed for this Run" — not "the queue is empty"; an
   * installed store always reports the facts, with zero counts when there are none.
   */
  readonly runInputs?: RunInputSnapshot;
}

export interface RunExecutionMessageAppend {
  readonly draft: AgentMessageRecordDraft;
  /** Attachment truth to commit as MESSAGE references with this USER record. */
  readonly attachmentIds?: readonly AttachmentId[];
}

export interface RunExecutionStepWrite {
  readonly operation: "INSERT" | "UPDATE";
  readonly step: AgentStep;
}

export type RunExecutionContinuationWrite =
  | {
      readonly operation: "SET";
      readonly checkpoint: RunContinuationCheckpoint;
      readonly updatedAt: TimestampMs;
    }
  | {
      readonly operation: "CLEAR";
    };

/**
 * One atomic durable transition.
 *
 * It is a *description*: the planner produces it, the RunController hands it to the store, and
 * the store commits all of it or none of it. An absent optional field means "this transition
 * leaves it alone", never "this transition clears it".
 */
export interface RunExecutionCommit {
  /** Already encrypted by the host. Written with the Assistant reference in this transaction. */
  readonly privateReplayWrites?: readonly PrivateReplayWrite[];
  readonly run: AgentRun;
  readonly state?: AgentState;
  readonly expectedStateRevision: number | null;
  readonly expectedContinuationRevision: number | null;
  readonly stepWrites: readonly RunExecutionStepWrite[];
  readonly messagesToAppend: readonly RunExecutionMessageAppend[];
  readonly continuation?: RunExecutionContinuationWrite;
  /**
   * Input handoff (T2) and first-assignment (T3) facts, committed with the transition above.
   *
   * They are fields of this commit rather than separate calls so a USER message can never exist
   * without its input mapping, and an input mapping can never claim a step that was not opened.
   */
  readonly runInputs?: RunInputCommit;
  readonly events: readonly DurableEventDraft[];
}

export interface RunExecutionCommitResult {
  readonly snapshot: RunExecutionSnapshot;
  readonly events: readonly DurableAgentEvent[];
}

/** The general durable Run execution port. */
export interface RunExecutionStorePort {
  load(runId: RunId): Promise<RunExecutionSnapshot | null>;
  commit(command: RunExecutionCommit): Promise<RunExecutionCommitResult>;
  requestCancellation(runId: RunId, intent: RunCancellationIntent): Promise<RunExecutionSnapshot>;
}

/** A concurrent write lost the optimistic-revision race. */
export class RunExecutionConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunExecutionConflictError";
  }
}

/**
 * The completion transaction found an input the Run never applied.
 *
 * It is a *conflict*, not a failure: the caller still holds the frozen model effect and must
 * settle it into a deferred boundary with the same provider turn, Tool results and usage. Mapping
 * it onto `FAILED` would durably claim the model produced nothing when it produced an answer the
 * Run still owes an apply to.
 */
export class RunInputPendingError extends RunExecutionConflictError {
  constructor(message = "the Run has accepted inputs that were never applied") {
    super(message);
    this.name = "RunInputPendingError";
  }
}

/** The durable record and the transition disagree about what the Run is. */
export class RunExecutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionInvariantError";
  }
}
