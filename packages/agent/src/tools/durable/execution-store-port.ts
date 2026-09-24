import type {
  ApprovalRequest,
  DurableRunEvent,
  RunId,
  SessionId,
  StepId,
  TimestampMs,
  ToolInvocation,
  ToolInvocationId,
  ToolObservation,
} from "@caelush/protocol";

import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { ToolSettlementExtension } from "../result/result-policy.js";

/**
 * One durable Tool execution event, before it has a sequence.
 *
 * ```text
 * DurableToolEventDraft    what the Tool layer asks Storage to append
 * DurableToolEvent         the same event after Storage assigned its durable sequence
 * ```
 *
 * A draft carries no `sequence`: the durable sequence is assigned by the store inside the commit
 * transaction, and it — never a timestamp — is the canonical chronology of what happened. The
 * declaration is intentionally structural rather than an alias of a legacy type: Phase 4F removed the
 * `@caelush/tools` package, so the store contract declared here is the only declaration, and it can be
 * implemented and consumed without any legacy package existing.
 */
export type DurableToolEventDraft = DurableRunEventDraft;

/** A committed durable Tool event: the same value with Storage's sequence attached. */
export type DurableToolEvent = DurableRunEvent;

/**
 * Everything durable that is known about one Tool invocation, at one revision.
 *
 * ```ts
 * export interface ToolExecutionSnapshot {
 *   readonly sessionId: SessionId;
 *   readonly invocation: ToolInvocation;
 *   readonly revision: number;
 *   readonly observation?: ToolObservation;
 *   readonly approval?: ApprovalRequest;
 * }
 * ```
 *
 * Five fields, and the list is closed. A snapshot is a **commit token**, not a workspace: it carries
 * the invocation, the revision a commit must still match, and the two durable satellites an
 * invocation may have. It deliberately carries no registry, no Runtime, no security facts, no
 * `AgentState`, no budget ledger and no effects — a recovery decision that needed any of those would
 * be re-deriving execution rather than resuming it.
 *
 * ## Revision
 *
 * `revision` is optimistic concurrency, owned by the store. A commit states the revision it observed
 * (`expectedRevision`), and the store refuses the commit when the row has moved on. That refusal —
 * not a lock and not an in-process set — is what makes a second writer safe.
 */
export interface ToolExecutionSnapshot {
  readonly sessionId: SessionId;
  readonly invocation: ToolInvocation;
  readonly revision: number;
  readonly observation?: ToolObservation | undefined;
  readonly approval?: ApprovalRequest | undefined;
}
/**
 * One atomic Tool execution commit.
 *
 * ```ts
 * export interface ToolExecutionCommit {
 *   readonly sessionId: SessionId;
 *   readonly invocation: ToolInvocation;
 *   readonly expectedRevision: number | null;
 *   readonly observation?: ToolObservation;
 *   readonly approval?: ApprovalRequest;
 *   readonly approvalKey?: string;
 *   readonly budgetStart?: { ownerId: ToolInvocationId; startedAt: TimestampMs };
 *   readonly events: readonly DurableToolEventDraft[];
 *   readonly extension?: ToolSettlementExtension;
 * }
 * ```
 *
 * ## One transaction
 *
 * A commit is the **only** way durable Tool state changes, and it is atomic: the invocation row, its
 * observation, an approval and its internal key, the budget reservation's move to `IN_FLIGHT`, the
 * host's state projection and every durable event settle together or not at all.
 *
 * ```text
 * terminal invocation
 * + observation
 * + effects extension → host state projection
 * + durable events
 * + budget terminal transition
 *         ↓
 *   one SQLite transaction
 * ```
 *
 * ## `expectedRevision` is nullable, and `null` is meaningful
 *
 * `null` states "no invocation row exists yet", which is what the first commit of a call must assert.
 * Using `undefined` for the same meaning would make "do not check" and "must not exist" the same
 * value, and a create-then-create race would be invisible.
 *
 * ## What the general layer may not put here
 *
 * ```text
 * ToolEffect[]        a Coding vocabulary; it travels inside `extension`, opaquely
 * AgentState          a host projection; Storage applies it, the Agent layer never sees it
 * ToolSettlementExtension.kind interpretation   the general layer stores and forwards the value
 * ```
 */
export interface ToolExecutionCommit {
  readonly sessionId: SessionId;
  readonly invocation: ToolInvocation;
  /** `null` means "this invocation must not exist yet". */
  readonly expectedRevision: number | null;

  readonly observation?: ToolObservation | undefined;

  /** A durable approval to create *in the same transaction* as the waiting invocation. */
  readonly approval?: ApprovalRequest | undefined;
  /** The opaque admission identity that approval was created under. */
  readonly approvalKey?: string | undefined;

  /**
   * Move the matching Tool budget reservation to `IN_FLIGHT` in this same transaction.
   *
   * It is a data-only hint, not a ledger handle: the store knows which row to move, and the Agent
   * layer never learns that a ledger exists.
   */
  readonly budgetStart?:
    | {
        readonly ownerId: ToolInvocationId;
        readonly startedAt: TimestampMs;
      }
    | undefined;

  readonly events: readonly DurableToolEventDraft[];

  /**
   * The opaque settlement extension the canonical result pipeline produced.
   *
   * The general layer treats it as `{ kind, payload }` and nothing more. A host compatibility boundary
   * decodes the kinds it declared — the production one turns `caelush.coding.effects.v1` back into the
   * existing Coding Tool effects and applies them to host state in this same transaction. An unknown
   * kind is a fail-closed rollback, never a silent drop: a Tool must not be recorded `COMPLETED` while
   * the effects it had are lost.
   */
  readonly extension?: ToolSettlementExtension | undefined;
}

/** What a successful commit produced. */
export interface ToolExecutionCommitResult {
  readonly snapshot: ToolExecutionSnapshot;
  readonly events: readonly DurableToolEvent[];
}

/**
 * The durable Tool execution store.
 *
 * ```ts
 * export interface ToolExecutionStorePort {
 *   load(invocationId): Promise<ToolExecutionSnapshot | null>;
 *   findByExternalCall(runId, sourceStepId, externalCallId): Promise<ToolExecutionSnapshot | null>;
 *   commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult>;
 * }
 * ```
 *
 * Three methods. `@caelush/agent` declares the contract; `@caelush/storage` implements it with SQLite.
 * The direction is one-way:
 *
 * ```text
 * Storage may know SQLite, Drizzle, transactions and migrations
 * Agent may know none of them
 * ```
 *
 * `findByExternalCall` is the idempotency lookup, and the identity it takes is the **whole** identity:
 * `(runId, sourceStepId, externalCallId)`. Never the invocation id alone (an unknown id cannot find an
 * existing call), never `toolName + args` (two identical calls in one Run are two calls), never a batch
 * position (positions are not durable).
 */
export interface ToolExecutionStorePort {
  load(invocationId: ToolInvocationId): Promise<ToolExecutionSnapshot | null>;

  findByExternalCall(
    runId: RunId,
    sourceStepId: StepId,
    externalCallId: string,
  ): Promise<ToolExecutionSnapshot | null>;

  commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult>;
}
