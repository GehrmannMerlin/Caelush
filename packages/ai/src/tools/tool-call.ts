import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/** A completed tool call requested by the model. */
export interface AIToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

/**
 * Why the model stopped.
 *
 * `OTHER` is a distinct outcome and must never be reinterpreted as `STOP`: an
 * unrecognised provider finish reason is not evidence that the model finished
 * its answer.
 */
export type AIFinishReason = "STOP" | "LENGTH" | "TOOL_CALLS" | "CONTENT_FILTER" | "OTHER";

/** Every frozen finish reason, in canonical order. */
export const AI_FINISH_REASONS = [
  "STOP",
  "LENGTH",
  "TOOL_CALLS",
  "CONTENT_FILTER",
  "OTHER",
] as const;

const TOOL_CALL_KEYS = ["id", "name", "input"] as const;

/** True when the value is one of the frozen finish reasons. */
export function isAIFinishReason(value: unknown): value is AIFinishReason {
  return typeof value === "string" && (AI_FINISH_REASONS as readonly string[]).includes(value);
}

/** Assert a frozen finish reason. */
export function assertAIFinishReason(value: unknown): asserts value is AIFinishReason {
  if (!isAIFinishReason(value)) {
    throw new TypeError(`AI finish reason is unknown: ${describeValue(value)}.`);
  }
}

/** Assert a well-formed completed tool call. */
export function assertAIToolCall(value: unknown): asserts value is AIToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI tool call must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;

  assertExactKeys(candidate, TOOL_CALL_KEYS, "AI tool call");
  assertNonEmptyString(candidate.id, "AI tool call id");
  assertNonEmptyString(candidate.name, "AI tool call name");
  if (!isJsonObject(candidate.input)) {
    throw new TypeError(
      `AI tool call input must be a JSON object, received ${describeValue(candidate.input)}.`,
    );
  }
}
