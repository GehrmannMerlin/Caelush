import type { RunId, TimestampMs } from "@caelush/protocol";

import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageId, ConversationTurnId } from "../types/ids.js";
import type { AgentMessageProjectorRegistry } from "../projection/registry.js";
import type { ConversationTurn } from "./conversation-turn.js";
import type { TokenEstimator } from "./token-estimator.js";

/**
 * One assistant Tool-call message and the Tool results that answer it.
 *
 * ```text
 * id                       deterministic: derived from the Run and the assistant message
 * runId                    the Run
 * conversationTurnId       the turn it belongs to
 * sourceSequenceFrom/To    the stored sequence range it covers, inclusive
 * status                   OPEN while a result is missing, CLOSED once all have arrived
 * assistantMessageId       the message that opened it
 * toolCallIds              the calls the assistant announced, in announcement order
 * toolResultMessageIds     the results that answered them
 * projectedTokenEstimate   what the unit costs the model, measured on the *projection*
 * createdAt / closedAt     when it opened and, if it has, when it closed
 * ```
 *
 * ## Identity is derived, never positional
 *
 * The id is `${runId}:execution:${assistantMessageId}`. An array index would be an identity
 * that changes when an unrelated message is inserted earlier in the conversation — which is
 * exactly what a compaction, a backfill or a merge does — and a durable pointer that
 * silently starts naming a different unit is worse than no pointer.
 *
 * ## OPEN is a real state, not an error
 *
 * A Tool batch that is still running, a Run that was cancelled mid-batch and a Run that
 * crashed after the assistant message was written all leave an open execution unit. It is
 * legitimate and it is *load-bearing*:
 *
 * ```text
 * a CLOSED unit may be compacted       it is answered, so a summary can replace it
 * an OPEN unit may not                 the model is still waiting for the answer
 * ```
 *
 * ## Compaction invariant
 *
 * Only a `CLOSED` unit is a safe compaction candidate. That is stated here, in the type that
 * knows it, rather than in a compaction algorithm — Phase 5A establishes the invariant and
 * does not rewrite compaction.
 */
export interface ExecutionUnit {
  readonly id: string;

  readonly runId: RunId;

  readonly conversationTurnId: ConversationTurnId;

  readonly sourceSequenceFrom: number;

  readonly sourceSequenceTo: number;

  readonly status: "OPEN" | "CLOSED";

  readonly assistantMessageId: AgentMessageId;

  readonly toolCallIds: readonly string[];

  readonly toolResultMessageIds: readonly AgentMessageId[];

  readonly projectedTokenEstimate: number;

  readonly createdAt: TimestampMs;

  readonly closedAt?: TimestampMs;
}

/** The deterministic identity of one execution unit. */
export function executionUnitId(runId: RunId, assistantMessageId: AgentMessageId): string {
  return `${runId}:execution:${assistantMessageId}`;
}

/**
 * True when a unit may be safely replaced by a summary.
 *
 * ```text
 * CLOSED                     every announced call has an answer
 * toolResultMessageIds == toolCallIds in count
 * ```
 *
 * The count check is not redundant with `status`. `status` is a *claim* a builder makes; the
 * counts are the *evidence* for it. A unit that claimed `CLOSED` with a missing result would
 * pass a status-only check and then be compacted away, and the model would never learn what
 * the Tool it called actually returned.
 */
export function isCompactionCandidate(unit: ExecutionUnit): boolean {
  return unit.status === "CLOSED" && unit.toolResultMessageIds.length === unit.toolCallIds.length;
}

/**
 * Group one turn's messages into execution units.
 *
 * ```text
 * an ASSISTANT message with at least one TOOL_CALL   opens a unit
 * subsequent TOOL_RESULT messages whose toolCallId is announced by that unit   answer it
 * a later assistant Tool-call message   opens the next unit
 * ```
 *
 * ## Two deliberate properties
 *
 * ```text
 * a message with no Tool calls produces no unit        there is nothing to answer
 * only the *model-visible* Tool protocol forms units    a hidden message cannot open,
 *                                                      answer or break a unit
 * ```
 *
 * The second is what keeps a debug-only or transcript-only message from creating a unit that
 * no model view can ever close. The projection is the model view, so the grouping follows the
 * same `audience.model` rule the validator and projector do.
 *
 * Results are attributed by `toolCallId` rather than by position, and a result whose call the
 * unit did not announce is skipped: it belongs to another unit or to none, and attributing it
 * by adjacency is how a Tool's output ends up paired with the wrong call.
 */
export function buildExecutionUnits(
  turn: ConversationTurn,
  estimator: TokenEstimator,
  projector: AgentMessageProjectorRegistry,
): readonly ExecutionUnit[] {
  const units: ExecutionUnit[] = [];

  for (const [index, stored] of turn.messages.entries()) {
    const message: AgentMessage = stored.message;
    if (message.type !== "ASSISTANT" || !message.audience.model) continue;
    const calls = message.content.filter((part) => part.type === "TOOL_CALL");
    if (calls.length === 0) continue;

    const callIds = calls.map((call) => call.toolCallId);
    const resultIds: AgentMessageId[] = [];
    const answered = new Set<string>();
    let endIndex = index;
    let lastSequence = stored.sequence;

    for (let cursor = index + 1; cursor < turn.messages.length; cursor += 1) {
      const candidate = turn.messages[cursor];
      if (candidate === undefined) break;
      const candidateMessage: AgentMessage = candidate.message;
      if (candidateMessage.type === "ASSISTANT") break;
      if (candidateMessage.type !== "TOOL_RESULT") continue;
      if (!candidateMessage.audience.model) continue;
      if (!callIds.includes(candidateMessage.toolCallId)) continue;
      if (answered.has(candidateMessage.toolCallId)) continue;
      answered.add(candidateMessage.toolCallId);
      resultIds.push(candidateMessage.id);
      endIndex = cursor;
      lastSequence = candidate.sequence;
      if (resultIds.length === callIds.length) break;
    }

    // The unit's own projection, measured on what the model would actually be shown. A unit
    // that measured its durable JSON would over-count identity and envelope fields the model
    // never receives.
    const members = turn.messages.slice(index, endIndex + 1);
    const projected = members.flatMap((member) => [...projector.project(member).messages]);

    const closed = resultIds.length === callIds.length;
    const lastMember = members[members.length - 1];
    units.push(
      Object.freeze({
        id: executionUnitId(turn.runId, message.id),
        runId: turn.runId,
        conversationTurnId: turn.id,
        sourceSequenceFrom: stored.sequence,
        sourceSequenceTo: lastSequence,
        status: closed ? ("CLOSED" as const) : ("OPEN" as const),
        assistantMessageId: message.id,
        toolCallIds: Object.freeze([...callIds]),
        toolResultMessageIds: Object.freeze([...resultIds]),
        projectedTokenEstimate: estimator.estimateMessages(projected),
        createdAt: message.createdAt,
        ...(closed && lastMember !== undefined ? { closedAt: lastMember.message.createdAt } : {}),
      }),
    );
  }

  return Object.freeze(units);
}

/** Every execution unit of a snapshot, in turn then announcement order. */
export function buildConversationExecutionUnits(
  turns: readonly ConversationTurn[],
  estimator: TokenEstimator,
  projector: AgentMessageProjectorRegistry,
): readonly ExecutionUnit[] {
  return Object.freeze(
    turns.flatMap((turn) => [...buildExecutionUnits(turn, estimator, projector)]),
  );
}
