import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import type { AgentConversationSnapshot } from "../conversation/conversation-snapshot.js";
import type { ConversationTurn } from "../conversation/conversation-turn.js";
import {
  conversationTurnStatus,
  createConversationTurn,
} from "../conversation/conversation-turn.js";
import { createAgentConversationSnapshot } from "../conversation/conversation-snapshot.js";
import type { AgentConversationValidator } from "../conversation/validator.js";
import { AgentConversationLoadError } from "../conversation/validator.js";
import type { AgentMessageDraft, AgentMessageRecord, StoredAgentMessage } from "./record.js";
import { assertAgentMessageSequence } from "./record.js";
import type { SessionReadableAgentMessageRecordStore } from "./record-store-port.js";
import type { AgentMessageCodecRegistry } from "../codec/registry.js";
import type { ConversationTurnIdFactory } from "../types/ids.js";

/**
 * Run lifecycle facts a conversation turn needs and a message ledger cannot supply.
 *
 * ```text
 * runId        the Run
 * sessionId    the Session that owns it
 * createdAt    when it was created — the turn's `openedAt`, and the session ordering key
 * finishedAt   when it reached a terminal status, when it has
 * terminal     whether it is terminal — the turn's status
 * ```
 *
 * ## Why this exists at all
 *
 * A `ConversationTurn` states `status`, `openedAt` and `closedAt`, and a message store knows none of
 * them: it holds messages, and a Run's lifecycle belongs to the Run Layer. The frozen
 * `AgentConversationRepository` interface therefore cannot answer `loadSnapshot` from a message store
 * alone, and this narrow reader is the injected seam that supplies exactly the missing five facts.
 *
 * ## What it may not be
 *
 * ```text
 * forbidden   RunController · Database · SQLite client · Drizzle client
 *             Workspace · Runtime · Context Engine · EventBus
 * ```
 *
 * It is a value lookup. Nothing about a Run's lifecycle *authority* moves: this reads a status a
 * lifecycle owner already decided, and it never transitions one.
 *
 * ## Why `terminal` rather than a status string
 *
 * A turn's status is `OPEN` or `CLOSED`, derived from whether the Run is terminal. Projecting the Run
 * status to a boolean at the boundary keeps the Run State Machine out of the Message Domain: this
 * layer never learns the Run vocabulary, and a new Run status cannot silently change a turn.
 */
export interface ConversationRunMetadataReader {
  read(runId: RunId): Promise<
    | {
        readonly runId: RunId;
        readonly sessionId: SessionId;
        readonly createdAt: TimestampMs;
        readonly finishedAt?: TimestampMs;
        readonly terminal: boolean;
      }
    | undefined
  >;
}

/**
 * The semantic conversation repository.
 *
 * ```text
 * AgentMessageDraft  →  versioned record  →  durable store
 * durable store      →  versioned record  →  StoredAgentMessage  →  snapshot
 * ```
 *
 * ## It composes the codec registry; it never replaces it
 *
 * Encoding and decoding are the registry's job and nothing here restates one of them:
 *
 * ```text
 * append         encode with the exact schema version the draft carries
 * listByRun      decode with the exact schema version the record carries
 * ```
 *
 * The registry is also the reason this layer can stay ignorant of message types: it asks a registry
 * for a codec, and a product layer that registers a custom type needs no change here.
 *
 * ## It does not re-decide the projection version
 *
 * `AgentMessageDraft.modelProjectionVersion` was decided by the codec registry when the draft was
 * encoded, and this layer copies it into the record. It never calls a projector, never asks for the
 * latest version and never defaults one — a message's model view was fixed by the projector that
 * produced it, and re-deciding it here would silently re-mean history.
 *
 * ## What it deliberately does not do
 *
 * ```text
 * no AI projection          that is the projector registry's question
 * no Context grouping       that is the Context Engine's question
 * no transcript rendering   that is the Client's question
 * no Run mutation           that is the Run Layer's question
 * ```
 */
export interface AgentConversationRepository {
  /** Encode, persist and return messages for one Run. */
  append(
    runId: RunId,
    drafts: readonly AgentMessageDraft[],
  ): Promise<readonly StoredAgentMessage[]>;

  /** Read one Run's conversation in the store's own order. */
  listByRun(runId: RunId): Promise<readonly StoredAgentMessage[]>;

  /**
   * Read a whole Session's conversation, with one Run marked as current.
   *
   * Throws when the current Run is not a turn of the Session, or when a record cannot be decoded:
   * a snapshot that silently omitted a message, or that invented a turn for a Run that is not there,
   * would be a conversation the validator would then have to be trusted to reject.
   */
  loadSnapshot(input: {
    readonly sessionId: SessionId;

    readonly currentRunId: RunId;
  }): Promise<AgentConversationSnapshot>;
}

export interface AgentConversationRepositoryDependencies {
  /** The codec registry: the one authority over what a record means. */
  readonly codecs: AgentMessageCodecRegistry;

  /** The record store, which must be able to answer session-wide reads. */
  readonly store: SessionReadableAgentMessageRecordStore;

  /**
   * The deterministic turn identity factory.
   *
   * `createDeterministicConversationTurnIdFactory()` is what a host composes, because a turn id must
   * be reproducible across processes for a snapshot load to agree with a backfill.
   */
  readonly turns: ConversationTurnIdFactory;

  /** The Run lifecycle facts a message ledger cannot supply. */
  readonly runMetadata: ConversationRunMetadataReader;

  /** The target Message V2 conversation authority. */
  readonly validator: AgentConversationValidator;
}

/**
 * Build the canonical conversation repository.
 *
 * ## The draft supplies its own bytes
 *
 * `AgentMessageDraft.data` is the codec's encoded payload, already proved JSON-safe by the registry that
 * produced it. This layer copies it verbatim into `AgentMessageRecord.data`, and never encodes, never
 * re-encodes and never asks for a different version — the draft names the codec that produced it, so
 * encoding again here would be a second encoder that could silently change the bytes.
 */
export function createAgentConversationRepository(
  dependencies: AgentConversationRepositoryDependencies,
): AgentConversationRepository {
  const { codecs, store, turns: turnIds, runMetadata, validator } = dependencies;

  return {
    async append(
      runId: RunId,
      drafts: readonly AgentMessageDraft[],
    ): Promise<readonly StoredAgentMessage[]> {
      if (drafts.length === 0) return Object.freeze([]);
      const recordDrafts = drafts.map((draft) => {
        const message = draft.message;
        if (message.runId !== runId) {
          // A draft whose message claims another Run cannot be appended to this one: the store binds
          // the Run outside the record, so the two would disagree about where the message lives.
          throw new TypeError("Agent message draft belongs to a different Run than the append.");
        }
        return {
          messageId: message.id,
          sessionId: message.sessionId,
          conversationTurnId: message.conversationTurnId,
          messageType: message.type,
          schemaVersion: draft.schemaVersion,
          // Copied, never re-decided: the codec registry already recorded which projector produced
          // this message's model view.
          ...(draft.modelProjectionVersion === undefined
            ? {}
            : { modelProjectionVersion: draft.modelProjectionVersion }),
          ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
          createdAt: message.createdAt,
          source: message.source,
          audience: message.audience,
          // The bytes the codec produced, written unchanged.
          data: draft.data,
        };
      });

      const records = await store.append(runId, recordDrafts);
      return Object.freeze(records.map((record) => decodeRecord(codecs, record)));
    },

    async listByRun(runId: RunId): Promise<readonly StoredAgentMessage[]> {
      const records = await store.listByRun(runId);
      return Object.freeze(records.map((record) => decodeRecord(codecs, record)));
    },

    async loadSnapshot(input: {
      readonly sessionId: SessionId;
      readonly currentRunId: RunId;
    }): Promise<AgentConversationSnapshot> {
      const records = await store.listBySession(input.sessionId);

      // Group by Run, preserving the store's ordering within each Run.
      const byRun = new Map<string, AgentMessageRecord[]>();
      for (const record of records) {
        const bucket = byRun.get(record.runId);
        if (bucket === undefined) byRun.set(record.runId, [record]);
        else bucket.push(record);
      }

      // The Run set is the union of the Runs that own messages and the current Run itself, because a
      // Run that has not written a message yet is still a turn of this Session.
      const runIds = new Set<string>(byRun.keys());
      runIds.add(input.currentRunId);

      const turns: ConversationTurn[] = [];
      for (const runId of runIds) {
        const metadata = await runMetadata.read(runId as RunId);
        if (metadata === undefined) {
          if (runId === input.currentRunId) {
            // The current Run must be a real Run of this Session. Inventing an empty turn for an
            // unknown Run would present a conversation that does not exist.
            throw new AgentConversationLoadError("CURRENT_RUN_NOT_FOUND");
          }
          // A record whose Run is gone is refused rather than silently dropped: dropping it would
          // hide a referential defect behind a smaller conversation.
          throw new AgentConversationLoadError("RUN_NOT_FOUND");
        }
        if (metadata.sessionId !== input.sessionId) {
          throw new AgentConversationLoadError("RUN_SESSION_MISMATCH");
        }
        const status = conversationTurnStatus(metadata.terminal);
        turns.push(
          createConversationTurn({
            // The deterministic derivation, never the clock-seeded default: a snapshot load must
            // reproduce the identity a backfill already wrote.
            id: turnIds.forRun(metadata.runId),
            sessionId: metadata.sessionId,
            runId: metadata.runId,
            status,
            openedAt: metadata.createdAt,
            // An OPEN turn must carry no closedAt, and a CLOSED Run without a finishedAt is a
            // truncated record rather than a turn that closed without a time.
            ...(status === "CLOSED" && metadata.finishedAt !== undefined
              ? { closedAt: metadata.finishedAt }
              : {}),
            messages: (byRun.get(runId) ?? []).map((record) => decodeRecord(codecs, record)),
          }),
        );
      }

      // Session order is Run.createdAt then Run.id, and a stable sort keeps equal keys in insertion
      // order so two loads of the same Session agree.
      turns.sort(compareTurns);

      const snapshot = createAgentConversationSnapshot({
        sessionId: input.sessionId,
        currentRunId: input.currentRunId,
        currentTurnId: turnIds.forRun(input.currentRunId),
        turns,
      });
      validator.validate(snapshot);
      return snapshot;
    },
  };
}

/* -------------------------------------------------------------------------------- internals */

/** Decode one record with the exact schema version it carries. */
function decodeRecord(
  codecs: AgentMessageCodecRegistry,
  record: AgentMessageRecord,
): StoredAgentMessage {
  assertAgentMessageSequence(record.sequence);
  const message = codecs.decode(record);
  return Object.freeze({
    sequence: record.sequence,
    schemaVersion: record.schemaVersion,
    ...(record.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: record.modelProjectionVersion }),
    message,
  });
}

/** Run.createdAt, then Run.id. */
function compareTurns(left: ConversationTurn, right: ConversationTurn): number {
  if (left.openedAt !== right.openedAt) return left.openedAt - right.openedAt;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}
