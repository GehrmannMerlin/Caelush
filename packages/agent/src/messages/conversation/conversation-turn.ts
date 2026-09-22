import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import type { ConversationTurnId } from "../types/ids.js";
import type { StoredAgentMessage } from "../persistence/record.js";

/**
 * Whether a conversation turn is still happening.
 *
 * ```text
 * OPEN     the Run it belongs to has not reached a terminal status
 * CLOSED   the Run is terminal, so nothing more can be added
 * ```
 *
 * The status mirrors the Run's lifecycle because the turn *is* that Run's conversation.
 * Phase 5A implements the derivation as a pure function and wires it to nothing: the
 * production `RunController` is not touched, and no host consults this yet. Phase 5B and
 * 5C build the production turn.
 */
export type ConversationTurnStatus = "OPEN" | "CLOSED";

/** Both statuses, in canonical order. */
export const CONVERSATION_TURN_STATUSES = [
  "OPEN",
  "CLOSED",
] as const satisfies readonly ConversationTurnStatus[];

/**
 * One turn of a conversation, as the Message Domain sees it.
 *
 * ```text
 * id          the turn identity, derived deterministically from the Run
 * sessionId   the Session
 * runId       the Run this turn is the conversation of
 * status      OPEN while the Run is non-terminal, CLOSED once it is
 * openedAt    when the turn opened
 * closedAt    when it closed, if it has
 * messages    the stored messages of this turn, in sequence order
 * ```
 *
 * ## A turn is a *view*, not a table
 *
 * Phase 5A creates no `conversation_turns` table and no migration. A turn is derivable
 * from the stored messages plus the Run's status, and deriving it keeps one durable
 * authority — the message ledger — instead of two that can disagree. Whether a later round
 * materializes a turn row is that round's decision; Phase 5A does not presuppose it.
 *
 * ## A turn is not an ExecutionUnit
 *
 * ```text
 * ConversationTurn   one user interaction, and everything the Agent did about it
 * ExecutionUnit      one assistant Tool-call message plus the Tool results that answer it
 * ```
 *
 * A turn contains zero or more execution units. The two are easy to confuse because both
 * group messages, and they group them for opposite purposes: a turn is *provenance* — what
 * belongs to which Run — while an execution unit is a *Tool protocol obligation* — which
 * calls have been answered. A turn may legitimately end with an open execution unit; an
 * execution unit never spans two Runs.
 *
 * ## `openedAt` is the session ordering key
 *
 * It carries the owning Run's `createdAt`, which is what makes turns orderable within a
 * Session. It is copied rather than looked up so a turn can be validated without loading
 * every Run in the Session.
 */
export interface ConversationTurn {
  readonly id: ConversationTurnId;

  readonly sessionId: SessionId;

  readonly runId: RunId;

  readonly status: ConversationTurnStatus;

  readonly openedAt: TimestampMs;

  readonly closedAt?: TimestampMs;

  readonly messages: readonly StoredAgentMessage[];
}

/**
 * Create a frozen conversation turn.
 *
 * The status/`closedAt` pair is checked here rather than left to a reader: a `CLOSED` turn
 * without a closing time cannot be ordered against another closed turn, and an `OPEN` turn
 * with one claims to have ended while still accepting messages.
 */
export function createConversationTurn(input: ConversationTurn): ConversationTurn {
  if (input.id.length === 0 || input.runId.length === 0 || input.sessionId.length === 0) {
    throw new TypeError("Conversation turn id, runId and sessionId must be non-empty.");
  }
  if (input.status === "CLOSED" && input.closedAt === undefined) {
    throw new TypeError("A closed conversation turn requires closedAt.");
  }
  if (input.status === "OPEN" && input.closedAt !== undefined) {
    throw new TypeError("An open conversation turn must not carry closedAt.");
  }
  return Object.freeze({
    ...input,
    messages: Object.freeze([...input.messages]),
  });
}

/**
 * Derive the turn status from whether the owning Run is terminal.
 *
 * The single statement of the mapping, so no host restates it:
 *
 * ```text
 * Run non-terminal → OPEN
 * Run terminal     → CLOSED
 * ```
 */
export function conversationTurnStatus(runIsTerminal: boolean): ConversationTurnStatus {
  return runIsTerminal ? "CLOSED" : "OPEN";
}
