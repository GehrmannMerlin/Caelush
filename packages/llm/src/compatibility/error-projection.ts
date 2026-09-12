import type { AIError, AIErrorContext } from "@caelush/ai";
import {
  LLMAbortedError,
  LLMAuthenticationError,
  LLMCapabilityUnsupportedError,
  LLMContextOverflowError,
  LLMError,
  LLMInvalidRequestError,
  LLMInvalidResponseError,
  LLMModelUnsupportedError,
  LLMNetworkError,
  LLMProviderError,
  LLMProviderNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../errors.js";
import type { ModelRef } from "@caelush/protocol";

/**
 * Project an AI core failure back onto the legacy `LLMError` hierarchy.
 *
 * Class identity matters: an existing consumer may branch on
 * `error instanceof LLMRateLimitError`, so the bridge constructs the real legacy
 * class rather than aliasing `AIError`. Retryability and `retryAfterMs` are carried
 * across as they are; the bridge never re-derives a retry policy.
 *
 * The message is passed through unchanged. It originates in the AI core, which
 * already refuses to copy raw headers, bodies or credentials into a message, and
 * the AI gateway sanitizer has run before the error reaches this point.
 */
export function toLegacyLLMError(error: AIError): LLMError {
  if (error instanceof LLMError) return error;

  const context: { providerId?: string; model?: ModelRef; cause?: unknown; retryAfterMs?: number } =
    {
      cause: error,
    };
  if (error.providerId !== undefined) context.providerId = error.providerId;
  if (error.model !== undefined) context.model = error.model;
  if (error.retryAfterMs !== undefined) context.retryAfterMs = error.retryAfterMs;

  switch (error.code) {
    case "AI_PROVIDER_NOT_FOUND":
      return new LLMProviderNotFoundError(error.providerId ?? error.model?.provider ?? "unknown");
    case "AI_MODEL_UNSUPPORTED":
      return error.model === undefined
        ? new LLMModelUnsupportedError({
            provider: error.providerId ?? "unknown",
            model: "unknown",
          })
        : new LLMModelUnsupportedError(error.model);
    case "AI_CAPABILITY_UNSUPPORTED":
      return error.model === undefined
        ? new LLMCapabilityUnsupportedError("unknown", {
            provider: error.providerId ?? "unknown",
            model: "unknown",
          })
        : new LLMCapabilityUnsupportedError("unknown", error.model);
    case "AI_INVALID_REQUEST":
      return new LLMInvalidRequestError(error.message, context);
    case "AI_AUTHENTICATION":
      return new LLMAuthenticationError(error.message, context);
    case "AI_RATE_LIMIT":
      return new LLMRateLimitError(error.message, context);
    case "AI_NETWORK":
      return new LLMNetworkError(error.message, context);
    case "AI_TIMEOUT":
      return new LLMTimeoutError(error.message, context);
    case "AI_CONTEXT_OVERFLOW":
      return new LLMContextOverflowError(context);
    case "AI_ABORTED":
      return new LLMAbortedError(error.message, context);
    case "AI_INVALID_RESPONSE":
      return new LLMInvalidResponseError(error.message, context);
    case "AI_MODEL_METADATA_INCOMPLETE":
      // The legacy provider could not describe the model, which the legacy contract
      // expresses as an unsupported model rather than as a new error class.
      return new LLMModelUnsupportedError(
        error.model ?? { provider: error.providerId ?? "unknown", model: "unknown" },
      );
    case "AI_ADAPTER_NOT_FOUND":
      // No legacy consumer can reach this: the compatibility facade supplies its own
      // adapter. A provider-level failure is the safest projection if it ever occurs.
      return new LLMProviderError(error.message, context);
    default:
      return new LLMProviderError(error.message, context);
  }
}

/** Project any thrown value onto the legacy error hierarchy. */
export function toLegacyError(error: unknown, fallback: AIErrorContext): LLMError {
  if (error instanceof LLMError) return error;
  if (isAIError(error)) return toLegacyLLMError(error);

  return new LLMProviderError("LLM provider threw an unexpected error.", {
    ...fallback,
    cause: error,
  });
}

/**
 * True when the value is an AI core failure.
 *
 * Detected structurally rather than with `instanceof`, because the AI core is a
 * separate package and a duplicated module instance must not defeat the bridge.
 */
function isAIError(value: unknown): value is AIError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly retryable?: unknown };
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean";
}

/** Re-exported so the facade can build a provider-range failure without importing AI. */
export function providerFailure(message: string, context: AIErrorContext): LLMError {
  return new LLMProviderError(message, {
    ...(context.providerId === undefined ? {} : { providerId: context.providerId }),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.cause === undefined ? {} : { cause: context.cause }),
  });
}
