import {
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  describeValue,
} from "../internal/assertions.js";
import { assertAIAssistantContent } from "./content.js";
import type { AIAssistantContent } from "./content.js";

/**
 * The frozen AI message contract.
 *
 * Phase 2A deliberately ships no image, audio, file or other multimodal message.
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

/** An assistant turn message. `content` must be non-empty. */
export interface AIAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AIAssistantContent[];
}

/** A tool result message produced outside the model. */
export interface AIToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

/** Any message the AI core can send to a model. */
export type AIMessage = AISystemMessage | AIUserMessage | AIAssistantMessage | AIToolResultMessage;

const SYSTEM_KEYS = ["role", "content"] as const;
const USER_KEYS = ["role", "content"] as const;
const ASSISTANT_KEYS = ["role", "content"] as const;
const TOOL_RESULT_KEYS = ["role", "toolCallId", "toolName", "content", "isError"] as const;

/**
 * Assert one well-formed message.
 *
 * Rejects unknown fields as well as wrong shapes: the AI core must never
 * silently accept a smuggled provider option or multimodal part.
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
      assertExactKeys(candidate, ASSISTANT_KEYS, "AI assistant message");
      const content = candidate.content;
      if (!Array.isArray(content) || content.length === 0) {
        throw new TypeError(
          `AI assistant message content must be a non-empty array, received ${describeValue(content)}.`,
        );
      }
      for (const part of content) assertAIAssistantContent(part);
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
