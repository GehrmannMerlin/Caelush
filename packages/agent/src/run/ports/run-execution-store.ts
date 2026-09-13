import type { AIMessage } from "@caelush/ai";
import type {
  AgentEvent,
  AgentRun,
  AgentState,
  AgentStep,
  EventDurability,
  RunCancellationIntent,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";

import type { RunContinuationCheckpoint } from "../continuation/continuation.js";

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
 * LLMMessage                                    the legacy durable message encoding
 * rows, SQL, Drizzle clients, database handles
 * ```
 *
 * A host that needs a verification-specific commit composes an extension port of its own; the
 * general contract must not grow a field only one subsystem can satisfy.
 */

type DurableEvent = Extract<EventDurability, { kind: "DURABLE" }>;

/** A durable event before the store assigns it a chronology sequence. */
export type DurableEventDraft = AgentEvent extends infer Event
  ? Event extends { type: string }
    ? Omit<Event, "durability"> & { durability: Omit<DurableEvent, "sequence"> }
    : never
  : never;

/** A durable event as the store returns it, with its sequence settled. */
export type DurableAgentEvent = AgentEvent extends infer Event
  ? Event extends { type: string }
    ? Omit<Event, "durability"> & { durability: DurableEvent }
    : never
  : never;

/**
 * One model-visible conversation entry.
 *
 * `message` is an `AIMessage`: the general Run domain speaks the frozen AI message contract, and
 * a legacy durable encoding is projected at the storage boundary rather than leaking inwards.
 */
export interface RunConversationEntry {
  readonly runId: RunId;
  readonly sequence: number;
  /** The Step that produced this entry, when a Step did. */
  readonly sourceStepId?: StepId;
  readonly createdAt: TimestampMs;
  readonly message: AIMessage;
}

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
  readonly conversation: readonly RunConversationEntry[];
  readonly continuation?: RunContinuationCheckpoint;
  readonly continuationRevision?: number;
  readonly cancellationIntent?: RunCancellationIntent;
}

export interface RunExecutionMessageAppend {
  readonly createdAt: TimestampMs;
  readonly sourceStepId?: StepId;
  readonly message: AIMessage;
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
  readonly run: AgentRun;
  readonly state?: AgentState;
  readonly expectedStateRevision: number | null;
  readonly expectedContinuationRevision: number | null;
  readonly stepWrites: readonly RunExecutionStepWrite[];
  readonly messagesToAppend: readonly RunExecutionMessageAppend[];
  readonly continuation?: RunExecutionContinuationWrite;
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

/** The durable record and the transition disagree about what the Run is. */
export class RunExecutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionInvariantError";
  }
}
