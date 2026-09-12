import { AI_ERROR_DEFAULT_MESSAGES, DEFAULT_AI_ERROR_RETRYABILITY } from "./ai-error-code.js";
import type { AIErrorCode } from "./ai-error-code.js";
import type { ModelRef } from "../models/model-ref.js";

/**
 * Optional, non-secret context for an AI failure.
 *
 * `cause` stays on the `Error` object for local debugging and is never
 * serialized. `providerId`, `model` and `retryAfterMs` are safe to expose.
 */
export interface AIErrorContext {
  readonly providerId?: string;
  readonly model?: ModelRef;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * The single AI failure type.
 *
 * `retryable` is derived from the frozen per-code table rather than supplied by
 * the caller, so retryability can never drift per call site.
 */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly providerId: string | undefined;
  readonly model: ModelRef | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: AIErrorCode, message: string, context: AIErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "AIError";
    this.code = code;
    this.providerId = context.providerId;
    this.model = context.model;
    this.retryable = DEFAULT_AI_ERROR_RETRYABILITY[code];

    if (
      context.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(context.retryAfterMs) || context.retryAfterMs < 0)
    ) {
      throw new TypeError("AI retryAfterMs must be an optional safe nonnegative integer.");
    }
    this.retryAfterMs = context.retryAfterMs;
  }
}

/**
 * Create an {@link AIError} with the frozen default message when none is given.
 *
 * Retryability always comes from the frozen table for `code`.
 */
export function createAIError(
  code: AIErrorCode,
  message: string = AI_ERROR_DEFAULT_MESSAGES[code],
  context: AIErrorContext = {},
): AIError {
  return new AIError(code, message, context);
}

/** True when the value is an AI failure, including one thrown across a realm-safe boundary. */
export function isAIError(value: unknown): value is AIError {
  return value instanceof AIError;
}
