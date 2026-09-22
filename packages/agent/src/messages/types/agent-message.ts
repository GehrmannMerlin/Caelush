import type { AgentAssistantMessage } from "./assistant-message.js";
import type { CustomAgentMessages } from "./custom-agent-messages.js";
import type { AgentToolResultMessage } from "./tool-result-message.js";
import type { AgentUserMessage } from "./user-message.js";

/**
 * Everything that can actually happen in an Agent conversation.
 *
 * ```text
 * USER          the human spoke
 * ASSISTANT     the model spoke
 * TOOL_RESULT   a Tool answered
 * CustomAgentMessages   a product layer added an arm through declaration merging
 * ```
 *
 * ## There is no `AgentSystemMessage`, and there must never be one
 *
 * A system instruction is not something that *happened* in a conversation. It is
 * material a Context Materializer authored for one provider request, out of project
 * facts, policy and synthetic reference context. Giving it a durable `AgentMessage` arm
 * would make "the model was told X for this turn" indistinguishable from "X was part of
 * the conversation", and the consequence is concrete: a replayed turn would find the
 * previous turn's system prompt sitting in the history and send it to the provider as
 * conversation, or a compaction would preserve a system instruction that no longer
 * applies.
 *
 * So the union excludes it, `AgentMessageProjector.project()` returns
 * `AIConversationMessage[]` rather than `AIMessage[]`, and a Phase 5A architecture guard
 * asserts no `SYSTEM` arm and no `AgentSystemMessage` declaration exists anywhere in the
 * Message Domain. System injection is impossible *by type* rather than by review.
 *
 * ## Why the custom arm is spelled as an indexed access
 *
 * `CustomAgentMessages[keyof CustomAgentMessages]` is the empty union until a product
 * layer merges an arm in, so the union is exactly the three canonical kinds in Phase 5A
 * and gains arms only where a host explicitly asked. That is what makes this a
 * *closed* extension point: a message kind has to be declared to exist.
 */
export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage
  | CustomAgentMessages[keyof CustomAgentMessages];

/** Every canonical message type discriminant, in canonical order. */
export const AGENT_MESSAGE_TYPES = ["USER", "ASSISTANT", "TOOL_RESULT"] as const;

/** The canonical message type of one message. */
export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[number];

/**
 * The discriminant of a message, or `undefined` when the value is not a message.
 *
 * The Message Domain reads `type` rather than `role`, deliberately: `role` is the AI
 * protocol's word for a provider-facing classification, and reusing it here would make
 * `AgentMessage` look like a rename of `AIMessage` rather than a separate language.
 */
export function agentMessageType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
