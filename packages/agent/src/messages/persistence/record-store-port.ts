import type { RunId, SessionId } from "@caelush/protocol";

import type { AgentMessageRecord, AgentMessageRecordDraft } from "./record.js";

/**
 * The durable record store.
 *
 * ```text
 * @caelush/agent      owns the contract        this file
 * @caelush/storage    implements it            an outer adapter
 * ```
 *
 * The direction is one-way and stays one-way: `@caelush/agent` must never import a storage package,
 * and a Message Domain that could reach into SQLite would be a Message Domain able to disagree with
 * its own contract. What the Agent owns is the *shape* of the durable record; who writes the bytes is
 * somebody else's job.
 *
 * ## The port speaks records, never messages
 *
 * ```text
 * AgentMessageRecord        what this port carries
 * AgentMessage              never — that is the codec registry's question
 * provider message arrays     never — the AI language is not durable here
 * ```
 *
 * A store that decoded a record into a semantic message would need the codec registry, which would
 * make Storage a second decoding authority and couple it to every message type a product layer adds.
 * The codec registry stays the one authority over what a record *means*; the store's whole job is that
 * the bytes it returns are the bytes that were written.
 *
 * ## There is deliberately no update and no delete
 *
 * A message is append-only. There is no `updateMessage`, no `replaceMessage` and no `deleteMessage`,
 * because the conversation ledger is the account of what happened: a mutable message would make "what
 * the model was shown" a claim about the present rather than a fact about the turn that ran.
 */
export interface AgentMessageRecordStorePort {
  /**
   * Append records to a Run's conversation and return them with their assigned sequence.
   *
   * ```text
   * input    the Run, and the drafts to append in order
   * output   the same records, each carrying the sequence the store assigned
   * ```
   *
   * The caller never supplies a `sequence` — `AgentMessageRecordDraft` has no such field — so the
   * store is the only ordering authority. A batch is assigned one contiguous range inside a single
   * transaction, so a reader never observes a partially appended batch.
   */
  append(
    runId: RunId,
    records: readonly AgentMessageRecordDraft[],
  ): Promise<readonly AgentMessageRecord[]>;

  /** Every record of one Run, ordered by the sequence the store assigned. */
  listByRun(runId: RunId): Promise<readonly AgentMessageRecord[]>;

  /**
   * Every record of one Session, across all of its Runs.
   *
   * Optional on the frozen contract, and it stays optional here. A store that cannot answer it is
   * still a complete record store; a caller that *needs* it — the conversation repository's
   * `loadSnapshot` is the one — requires the capability structurally at composition rather than by
   * promoting this member to mandatory.
   */
  listBySession?(sessionId: SessionId): Promise<readonly AgentMessageRecord[]>;
}

/**
 * A record store that can answer session-wide reads.
 *
 * The conversation repository composes this rather than the bare port, so "the store cannot read a
 * Session" is a composition error instead of a runtime surprise halfway through a snapshot load. The
 * frozen optional member is narrowed, never widened: a full `AgentMessageRecordStorePort` satisfies
 * this type whenever it implements `listBySession`.
 */
export type SessionReadableAgentMessageRecordStore = AgentMessageRecordStorePort &
  Required<Pick<AgentMessageRecordStorePort, "listBySession">>;
