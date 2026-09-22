import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

import type { AgentMessageAudience } from "./audience.js";
import type { AgentMessageId, ConversationTurnId } from "./ids.js";
import type { AgentMessageSource } from "./source.js";

/**
 * What every Agent message is, before it becomes any particular kind of message.
 *
 * ```text
 * id                    its own durable identity, minted before anything is written
 * runId                 the Run it belongs to
 * sessionId             the Session that Run belongs to
 * conversationTurnId    the conversation turn it belongs to
 * createdAt             when it was created
 * sourceStepId          the Step that produced it, when a Step did
 * source                provenance
 * audience              who may see it
 * ```
 *
 * ## There is no `sequence`, and that is a design decision
 *
 * `sequence` is not absent because it was forgotten. It is absent because it is a
 * **storage-assigned ordering**, not a semantic property, and putting it here would make
 * the semantic message type depend on which store wrote it:
 *
 * ```text
 * AgentMessageBase     what was said, by whom, to whom
 * AgentMessageRecord   the versioned durable envelope, which carries `sequence`
 * StoredAgentMessage   a record that has been given its sequence
 * ExecutionUnit        a source sequence *range* over stored messages
 * ```
 *
 * A message that knew its own position would be a message that could disagree with the
 * ledger it lives in — after a re-import, a compaction, or a backfill. Phase 5A ships an
 * architecture guard asserting this field is absent, so the omission cannot be quietly
 * undone by a later round that finds it convenient.
 *
 * ## Every field is readonly
 *
 * A durable `AgentAssistantMessage` is immutable once written: its content, its model
 * provenance, its provider state and its audience are all fixed at creation. Type-level
 * `readonly` is how this contract states that, because a message that could be edited in
 * place would make "what the model was shown" a claim about the present rather than a
 * fact about the turn that ran.
 */
export interface AgentMessageBase {
  readonly id: AgentMessageId;

  readonly runId: RunId;

  readonly sessionId: SessionId;

  readonly conversationTurnId: ConversationTurnId;

  readonly createdAt: TimestampMs;

  readonly sourceStepId?: StepId;

  readonly source: AgentMessageSource;

  readonly audience: AgentMessageAudience;
}

/**
 * Create the base fields of one message.
 *
 * The single construction point for `AgentMessageBase`, so no message kind can quietly
 * assemble a base with a missing field or an unfrozen audience.
 */
export function createAgentMessageBase(input: {
  readonly id: AgentMessageId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly conversationTurnId: ConversationTurnId;
  readonly createdAt: TimestampMs;
  readonly sourceStepId?: StepId | undefined;
  readonly source: AgentMessageSource;
  readonly audience: AgentMessageAudience;
}): AgentMessageBase {
  return Object.freeze({
    id: input.id,
    runId: input.runId,
    sessionId: input.sessionId,
    conversationTurnId: input.conversationTurnId,
    createdAt: input.createdAt,
    ...(input.sourceStepId === undefined ? {} : { sourceStepId: input.sourceStepId }),
    source: input.source,
    audience: Object.freeze({ ...input.audience }),
  });
}
