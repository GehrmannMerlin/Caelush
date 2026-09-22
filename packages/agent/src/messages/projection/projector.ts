import type { AIConversationMessage } from "@caelush/ai";

import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageProjectionVersion } from "../persistence/record.js";
import { digestJsonValue } from "../canonical-json.js";
import type { JsonValue } from "@caelush/ai";

/**
 * What one message looks like to a model.
 *
 * ```text
 * messages      the projected conversation, in order
 * fingerprint   a stable digest of exactly those messages
 * ```
 *
 * ## `messages` is `AIConversationMessage[]`, never `AIMessage[]`
 *
 * That is the type-level half of "a projector cannot inject a system prompt". A system
 * instruction is produced by the Context Materializer for one provider request; a
 * projector that could return one would be able to put durable conversation text where
 * system policy belongs. The narrower union makes that a compile error rather than a
 * review finding, and Phase 5A asserts it in an architecture guard as well.
 *
 * ## The fingerprint is over the projection, not over the message
 *
 * Two messages that differ in their durable envelope but project to the same model view
 * have the same fingerprint, and that is correct: the fingerprint answers "did what the
 * model is shown change?". Phase 5B uses it to prove that a re-projection matches the
 * stored one, which is how a projection regression is caught instead of shipped.
 */
export interface AgentMessageAIProjection {
  readonly messages: readonly AIConversationMessage[];

  readonly fingerprint: string;
}

/**
 * Project one Agent message into the AI conversation language.
 *
 * ```text
 * type      the message type this projector owns
 * version   its projection version; recorded durably with every message it projects
 * project   the pure projection
 * ```
 *
 * ## Every projector is pure
 *
 * ```text
 * pure            same input, same output, always
 * deterministic   no clock, no randomness, no environment
 * provider-neutral no provider name, SDK, adapter or dialect appears
 * side-effect-free no I/O, no mutation, no global state
 * ```
 *
 * A projector must not depend on a provider SDK, an API adapter, a filesystem, the
 * Runtime, the network, Storage or a mutable context policy. The reason is not stylistic:
 * a message is projected long after it was created, possibly during a recovery, possibly
 * for a *different* provider than the one that produced it. A projector that consulted
 * any of those would produce a different answer on a different day, and the durable
 * fingerprint would become a record of nothing.
 *
 * ## Versioning is what makes a projector changeable
 *
 * `version` is the reason a projector may ever be fixed. A message stores the version it
 * was projected under, so shipping a v2 changes what *new* messages mean without
 * changing what a historical one meant.
 */
export interface AgentMessageProjector<TMessage extends AgentMessage = AgentMessage> {
  readonly type: TMessage["type"];

  readonly version: AgentMessageProjectionVersion;

  project(message: TMessage): AgentMessageAIProjection;
}

/**
 * Assemble the frozen projection result, computing the fingerprint from the messages.
 *
 * A projector never states its own fingerprint. If it did, the digest could disagree with
 * the messages it describes — by accident or by a well-meaning cache — and the durable
 * receipt would then certify something untrue. The messages are copied and frozen here so
 * a caller holding the returned array cannot alter a projection after it was certified.
 */
export function createAgentMessageAIProjection(
  messages: readonly AIConversationMessage[],
): AgentMessageAIProjection {
  const frozen = Object.freeze(messages.map((message) => Object.freeze({ ...message })));
  return Object.freeze({
    messages: frozen,
    fingerprint: fingerprintProjection(frozen),
  });
}

/**
 * The canonical digest of a projected conversation.
 *
 * It is a SHA-256 over the key-sorted JSON of the message list, so the digest depends on
 * the semantic projection and on nothing else — not on property insertion order, not on
 * which process computed it, not on when.
 */
export function fingerprintProjection(messages: readonly AIConversationMessage[]): string {
  return digestJsonValue(messages as unknown as JsonValue);
}

/**
 * The canonical fingerprint of "the model is shown nothing".
 *
 * A message whose `audience.model` is `false` projects to no messages at all, and that is
 * a *successful* projection rather than a missing one. Naming its digest once — instead of
 * letting each caller compute the digest of an empty list — is what makes "was this
 * message shown to the model?" answerable by comparing two strings.
 */
export const EMPTY_AGENT_MESSAGE_AI_PROJECTION: AgentMessageAIProjection =
  createAgentMessageAIProjection([]);
