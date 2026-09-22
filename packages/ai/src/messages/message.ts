import {
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  describeValue,
} from "../internal/assertions.js";
import { assertAIContent } from "./content.js";
import type { AIContent } from "./content.js";
import { assertAIProviderOpaqueState } from "./provider-state.js";
import type { AIProviderOpaqueState } from "./provider-state.js";

/**
 * The frozen AI message contract.
 *
 * ```text
 * AIMessage               the whole model input language
 *   ├── AISystemMessage   a system instruction
 *   └── AIConversationMessage
 *         ├── AIUserMessage
 *         ├── AIAssistantMessage
 *         └── AIToolResultMessage
 * ```
 *
 * The two unions are not decoration. `AIConversationMessage` is the language of
 * *conversation*: what a user said, what a model answered, what a Tool returned. A
 * system instruction is not part of a conversation — it is authored by the Context
 * Materializer, from project facts, policy and synthetic reference context, and no
 * other layer may produce one. A projector that returns the narrower union therefore
 * cannot inject a system prompt *by type*, rather than by review.
 *
 * Phase 5A deliberately ships no image, audio, file or other multimodal message.
 */

/** A system instruction message. */
export interface AISystemMessage {
  readonly role: "system";
  readonly content: string;
}

/** A user turn message. */
export interface AIUserMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * An assistant turn message. `content` must be non-empty.
 *
 * `providerState` carries provider-opaque continuity data — a signature, a reasoning
 * envelope, a response handle — from a provider that requires it back on the next
 * turn. It is optional at every level: a provider that needs nothing, an adapter that
 * captured nothing, and a message that was created without a provider turn at all all
 * express themselves by its absence.
 */
export interface AIAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AIContent[];
  readonly providerState?: AIProviderOpaqueState;
}

/** A tool result message produced outside the model. */
export interface AIToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Every message a conversation can contain.
 *
 * `AISystemMessage` is deliberately not a member. This is the union a
 * conversation-facing producer is typed against, so "the model must not have a system
 * message projected into the middle of a conversation" is a compile-time fact.
 */
export type AIConversationMessage = AIUserMessage | AIAssistantMessage | AIToolResultMessage;

/** Any message the AI core can send to a model. */
export type AIMessage = AISystemMessage | AIConversationMessage;

const SYSTEM_KEYS = ["role", "content"] as const;
const USER_KEYS = ["role", "content"] as const;
const ASSISTANT_KEYS = ["role", "content"] as const;
const ASSISTANT_KEYS_WITH_STATE = ["role", "content", "providerState"] as const;
const TOOL_RESULT_KEYS = ["role", "toolCallId", "toolName", "content", "isError"] as const;

/**
 * Assert one well-formed message.
 *
 * Rejects unknown fields as well as wrong shapes: the AI core must never
 * silently accept a smuggled provider option or multimodal part. `providerState` is
 * accepted only where the contract defines it — an assistant turn — and only when it
 * is actually present, so the strictness of the other roles is unchanged.
 */
export function assertAIMessage(value: unknown): asserts value is AIMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI message must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;

  switch (candidate.role) {
    case "system":
      assertExactKeys(candidate, SYSTEM_KEYS, "AI system message");
      assertContentString(candidate.content, "AI system message");
      return;
    case "user":
      assertExactKeys(candidate, USER_KEYS, "AI user message");
      assertContentString(candidate.content, "AI user message");
      return;
    case "assistant": {
      assertExactKeys(
        candidate,
        candidate.providerState === undefined ? ASSISTANT_KEYS : ASSISTANT_KEYS_WITH_STATE,
        "AI assistant message",
      );
      const content = candidate.content;
      if (!Array.isArray(content) || content.length === 0) {
        throw new TypeError(
          `AI assistant message content must be a non-empty array, received ${describeValue(content)}.`,
        );
      }
      for (const part of content) assertAIContent(part);
      if (candidate.providerState !== undefined) {
        assertAIProviderOpaqueState(candidate.providerState);
      }
      return;
    }
    case "tool":
      assertExactKeys(candidate, TOOL_RESULT_KEYS, "AI tool result message");
      assertNonEmptyString(candidate.toolCallId, "AI tool result message toolCallId");
      assertNonEmptyString(candidate.toolName, "AI tool result message toolName");
      assertContentString(candidate.content, "AI tool result message");
      assertBoolean(candidate.isError, "AI tool result message isError");
      return;
    default:
      throw new TypeError(`AI message has an unknown role ${describeValue(candidate.role)}.`);
  }
}

/**
 * Assert one well-formed conversation message.
 *
 * A system instruction is not a conversation message, and this refuses one rather than
 * accepting it and leaving the rule to a caller's discipline.
 */
export function assertAIConversationMessage(
  value: unknown,
): asserts value is AIConversationMessage {
  assertAIMessage(value);
  if (value.role === "system") {
    throw new TypeError("AI conversation message must not be a system message.");
  }
}

/**
 * Assert a non-empty list of well-formed messages.
 *
 * An empty message list can never describe a model turn, so it is rejected at
 * the request boundary rather than sent as an empty prompt.
 */
export function assertAIMessages(value: unknown): asserts value is readonly AIMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`AI messages must be a non-empty array, received ${describeValue(value)}.`);
  }
  value.forEach((message, index) => {
    try {
      assertAIMessage(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TypeError(`AI messages[${String(index)}] is invalid: ${reason}`, { cause: error });
    }
  });
}

function assertContentString(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${label} content must be a string, received ${describeValue(value)}.`);
  }
}
