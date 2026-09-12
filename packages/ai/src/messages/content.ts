import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/**
 * Assistant content parts.
 *
 * The frozen V2 message contract is text/tool-first. Phase 2A adds no image,
 * audio, file or other multimodal part.
 */

/** A text part of an assistant message. */
export interface AIAssistantTextContent {
  readonly type: "text";
  readonly text: string;
}

/** A tool-call part of an assistant message. */
export interface AIAssistantToolCallContent {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

/** One part of an assistant message. */
export type AIAssistantContent = AIAssistantTextContent | AIAssistantToolCallContent;

const TEXT_KEYS = ["type", "text"] as const;
const TOOL_CALL_KEYS = ["type", "toolCallId", "toolName", "input"] as const;

/** True when the value is a well-formed assistant content part. */
export function isAIAssistantContent(value: unknown): value is AIAssistantContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "text") {
    try {
      assertExactKeys(candidate, TEXT_KEYS, "AI assistant text content");
    } catch {
      return false;
    }
    return typeof candidate.text === "string";
  }

  if (candidate.type === "tool-call") {
    try {
      assertExactKeys(candidate, TOOL_CALL_KEYS, "AI assistant tool-call content");
    } catch {
      return false;
    }
    return (
      typeof candidate.toolCallId === "string" &&
      candidate.toolCallId.length > 0 &&
      typeof candidate.toolName === "string" &&
      candidate.toolName.length > 0 &&
      isJsonObject(candidate.input)
    );
  }

  return false;
}

/** Assert a well-formed assistant content part. */
export function assertAIAssistantContent(value: unknown): asserts value is AIAssistantContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `AI assistant content must be an object, received ${describeValue(value)}.`,
    );
  }
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "text") {
    assertExactKeys(candidate, TEXT_KEYS, "AI assistant text content");
    if (typeof candidate.text !== "string") {
      throw new TypeError(
        `AI assistant text content text must be a string, received ${describeValue(candidate.text)}.`,
      );
    }
    return;
  }

  if (candidate.type === "tool-call") {
    assertExactKeys(candidate, TOOL_CALL_KEYS, "AI assistant tool-call content");
    assertNonEmptyString(candidate.toolCallId, "AI assistant tool-call toolCallId");
    assertNonEmptyString(candidate.toolName, "AI assistant tool-call toolName");
    if (!isJsonObject(candidate.input)) {
      throw new TypeError(
        `AI assistant tool-call input must be a JSON object, received ${describeValue(candidate.input)}.`,
      );
    }
    return;
  }

  throw new TypeError(`AI assistant content has an unknown type ${describeValue(candidate.type)}.`);
}
