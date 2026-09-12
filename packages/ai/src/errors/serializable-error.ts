import { assertExactKeys, describeValue } from "../internal/assertions.js";
import type { AIErrorCode } from "./ai-error-code.js";
import type { ModelRef } from "../models/model-ref.js";

/**
 * The safe, transportable form of an {@link AIError}.
 *
 * This is the only error shape allowed to cross the AI boundary into public
 * events, durable data or client DTOs. It must never carry a cause, a stack, raw
 * headers, credentials, a raw request or a raw provider body.
 */
export interface AISerializableError {
  readonly code: AIErrorCode;
  readonly message: string;
  readonly providerId?: string;
  readonly model?: ModelRef;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/** The exact serializable key set. */
export const SERIALIZABLE_ERROR_KEYS = [
  "code",
  "message",
  "providerId",
  "model",
  "retryable",
  "retryAfterMs",
] as const satisfies readonly (keyof AISerializableError)[];

/**
 * Assert a well-formed serializable error.
 *
 * An unknown field is rejected rather than ignored, because an unknown field is
 * exactly how a cause, a stack or a credential would try to cross the boundary.
 */
export function assertAISerializableError(value: unknown): asserts value is AISerializableError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `Serializable AI error must be an object, received ${describeValue(value)}.`,
    );
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, SERIALIZABLE_ERROR_KEYS, "Serializable AI error");

  if (typeof candidate.message !== "string") {
    throw new TypeError("Serializable AI error message must be a string.");
  }
  if (typeof candidate.retryable !== "boolean") {
    throw new TypeError("Serializable AI error retryable must be a boolean.");
  }
}
