import type { RunId, SessionId } from "@caelush/protocol";

import type { ConversationTurnId } from "../types/ids.js";
import type { ConversationTurn } from "./conversation-turn.js";

/**
 * A whole Session conversation, at one Run.
 *
 * ```text
 * sessionId       the Session
 * currentRunId    the Run this snapshot was taken for
 * currentTurnId   that Run's turn
 * turns           every turn of the Session, in order
 * ```
 *
 * ## Why a snapshot rather than a query
 *
 * ```text
 * Conversation     one Run's own messages
 * Snapshot         the whole Session, with one Run marked as current
 * ```
 *
 * The Message Domain's consumers need both: replay asks "what does *this* Run's model see",
 * while selection and compaction ask "what has this user and this Agent already said". A
 * snapshot answers both from one immutable value, so a validator can reason about the whole
 * thing at once instead of validating fragments that were read at different moments.
 *
 * ## Ordering is part of the contract
 *
 * ```text
 * turns              ordered by the owning Run's createdAt, then by Run identity
 * turn.messages      ordered by StoredAgentMessage.sequence, strictly increasing
 * ```
 *
 * The order is fixed rather than incidental because two consumers depend on it: a
 * validator can detect a sequence gap by walking the list once, and a selector can drop
 * from the tail knowing the tail is the newest material. A snapshot whose order depended on
 * a database page layout would make both of them heuristic.
 *
 * Phase 5A builds snapshots from fixtures and validates them. It does not read one from
 * Storage, because Storage does not produce one yet — that is Phase 5B and 5C.
 */
export interface AgentConversationSnapshot {
  readonly sessionId: SessionId;

  readonly currentRunId: RunId;

  readonly currentTurnId: ConversationTurnId;

  readonly turns: readonly ConversationTurn[];
}

/** Create a frozen snapshot. */
export function createAgentConversationSnapshot(
  input: AgentConversationSnapshot,
): AgentConversationSnapshot {
  return Object.freeze({ ...input, turns: Object.freeze([...input.turns]) });
}

/**
 * Create a single-turn snapshot.
 *
 * The shape a caller has when it holds exactly one Run's conversation, which is what every
 * existing production path holds today. It is the bridge a later round uses to feed a
 * run-scoped conversation into the Message Domain without inventing a Session reader.
 */
export function createSingleTurnConversationSnapshot(input: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly turn: ConversationTurn;
}): AgentConversationSnapshot {
  return createAgentConversationSnapshot({
    sessionId: input.sessionId,
    currentRunId: input.runId,
    currentTurnId: input.turn.id,
    turns: [input.turn],
  });
}
