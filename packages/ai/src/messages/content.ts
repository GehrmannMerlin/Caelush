import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/**
 * Provider-neutral AI content parts.
 *
 * Assistant messages remain text/tool-call content. User and Tool-result messages
 * may carry bounded-shape image parts whose bytes are encoded as base64 strings.
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

/** A text part in user input or a Tool result. */
export interface AIUserTextPart {
  readonly type: "text";
  readonly text: string;
}

/** Supported provider-neutral image media types. */
export type AIImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Optional provider-neutral image detail hint. */
export type AIImageDetail = "LOW" | "HIGH";

/** An encoded image part in user input or a Tool result. */
export interface AIUserImagePart {
  readonly type: "image";
  readonly mediaType: AIImageMediaType;
  /** Standard base64 image data without a data-URL prefix. */
  readonly data: string;
  readonly detail?: AIImageDetail;
}

/** One validated part of user input or a Tool result. */
export type AIUserContent = AIUserTextPart | AIUserImagePart;

/** Tool-result text or multimodal content. */
export type AIToolResultContent = string | readonly AIUserContent[];

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
const USER_TEXT_KEYS = ["type", "text"] as const;
const USER_IMAGE_KEYS = ["type", "mediaType", "data"] as const;
const USER_IMAGE_KEYS_WITH_DETAIL = ["type", "mediaType", "data", "detail"] as const;
const IMAGE_MEDIA_TYPES: readonly AIImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** True when the value is a well-formed user text or image part. */
export function isAIUserContent(value: unknown): value is AIUserContent {
  try {
    assertAIUserContent(value);
    return true;
  } catch {
    return false;
  }
}

/** Assert one well-formed user text or image part. */
export function assertAIUserContent(value: unknown): asserts value is AIUserContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI user content must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "text") {
    assertExactKeys(candidate, USER_TEXT_KEYS, "AI user text part");
    if (typeof candidate.text !== "string") {
      throw new TypeError(
        `AI user text must be a string, received ${describeValue(candidate.text)}.`,
      );
    }
    return;
  }
  if (candidate.type === "image") {
    assertExactKeys(
      candidate,
      candidate.detail === undefined ? USER_IMAGE_KEYS : USER_IMAGE_KEYS_WITH_DETAIL,
      "AI user image part",
    );
    if (!IMAGE_MEDIA_TYPES.includes(candidate.mediaType as AIImageMediaType)) {
      throw new TypeError("AI user image mediaType is unsupported.");
    }
    if (
      typeof candidate.data !== "string" ||
      candidate.data.length === 0 ||
      candidate.data.length % 4 !== 0 ||
      !BASE64_PATTERN.test(candidate.data)
    ) {
      throw new TypeError("AI user image data must be non-empty standard base64.");
    }
    if (
      candidate.detail !== undefined &&
      candidate.detail !== "LOW" &&
      candidate.detail !== "HIGH"
    ) {
      throw new TypeError("AI user image detail must be LOW or HIGH when provided.");
    }
    return;
  }
  throw new TypeError(`AI user content has an unknown type ${describeValue(candidate.type)}.`);
}

/** Assert a non-empty list of user text/image parts. */
export function assertAIUserContents(value: unknown): asserts value is readonly AIUserContent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      `AI user content parts must be a non-empty array, received ${describeValue(value)}.`,
    );
  }
  value.forEach(assertAIUserContent);
}

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
