import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/**
 * Assistant content parts.
 *
 * The frozen V2 message contract is text/tool-first. It adds no image, audio, file or
 * other multimodal part, and Phase 5A does not open provider multimodal input.
 *
 * ## Canonical names
 *
 * ```text
 * AITextContent       canonical
 * AIToolCallContent   canonical
 * AIContent           canonical union
 * ```
 *
 * The Message System V2 Interface Freeze names these three. Two aliases preserve the
 * names Phase 2A shipped under, because a rename is not a compatible change and the
 * whole repository still uses them:
 *
 * ```text
 * AIAssistantTextContent      = AITextContent
 * AIAssistantToolCallContent  = AIToolCallContent
 * AIAssistantContent          = AIContent
 * ```
 *
 * There is exactly **one** declaration per shape. The aliases are `export type`
 * bindings, not second interfaces, so no second validator, no second shape and no
 * second discriminant table can exist. Code written against either name sees the same
 * type, and `assertAIContent` is the only assertion for both.
 */

/** A text part. */
export interface AITextContent {
  readonly type: "text";
  readonly text: string;
}

/** A tool-call part. */
export interface AIToolCallContent {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

/** One part of an assistant message. */
export type AIContent = AITextContent | AIToolCallContent;

/** Phase 2A compatibility name for {@link AITextContent}. */
export type AIAssistantTextContent = AITextContent;

/** Phase 2A compatibility name for {@link AIToolCallContent}. */
export type AIAssistantToolCallContent = AIToolCallContent;

/** Phase 2A compatibility name for {@link AIContent}. */
export type AIAssistantContent = AIContent;

const TEXT_KEYS = ["type", "text"] as const;
const TOOL_CALL_KEYS = ["type", "toolCallId", "toolName", "input"] as const;

/** True when the value is a well-formed assistant content part. */
export function isAIContent(value: unknown): value is AIContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "text") {
    try {
      assertExactKeys(candidate, TEXT_KEYS, "AI text content");
    } catch {
      return false;
    }
    return typeof candidate.text === "string";
  }

  if (candidate.type === "tool-call") {
    try {
      assertExactKeys(candidate, TOOL_CALL_KEYS, "AI tool-call content");
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
export function assertAIContent(value: unknown): asserts value is AIContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI content must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "text") {
    assertExactKeys(candidate, TEXT_KEYS, "AI text content");
    if (typeof candidate.text !== "string") {
      throw new TypeError(
        `AI text content text must be a string, received ${describeValue(candidate.text)}.`,
      );
    }
    return;
  }

  if (candidate.type === "tool-call") {
    assertExactKeys(candidate, TOOL_CALL_KEYS, "AI tool-call content");
    assertNonEmptyString(candidate.toolCallId, "AI tool-call toolCallId");
    assertNonEmptyString(candidate.toolName, "AI tool-call toolName");
    if (!isJsonObject(candidate.input)) {
      throw new TypeError(
        `AI tool-call input must be a JSON object, received ${describeValue(candidate.input)}.`,
      );
    }
    return;
  }

  throw new TypeError(`AI content has an unknown type ${describeValue(candidate.type)}.`);
}

/**
 * Phase 2A compatibility name for {@link isAIContent}.
 *
 * A wrapper rather than a `const` binding: TypeScript only honours an assertion
 * signature on a *declared* function, so aliasing `assertAIContent` through a variable
 * would silently strip the narrowing every caller of the compatibility name relies on.
 */
export function isAIAssistantContent(value: unknown): value is AIContent {
  return isAIContent(value);
}

/** Phase 2A compatibility name for {@link assertAIContent}. See above for why this wraps. */
export function assertAIAssistantContent(value: unknown): asserts value is AIContent {
  assertAIContent(value);
}
