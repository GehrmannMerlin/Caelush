import { APICallError, InvalidResponseDataError, JSONParseError, TypeValidationError } from "ai";
import { AIError, createAIError } from "../../errors/ai-error.js";
import type { AIErrorCode } from "../../errors/ai-error-code.js";
import type { ModelRef } from "../../models/model-ref.js";

/**
 * Normalise any provider, SDK or transport failure into the frozen `AIError` set.
 *
 * The adapter never emits a raw SDK error and never builds its own retry
 * decision. Messages stay generic: a provider body, a header map or a credential
 * must not be copied into an error message, and the gateway sanitizer is the final
 * line of defence, not the first.
 */
export function normalizeOpenAICompatibleError(error: unknown, model: ModelRef): AIError {
  const context = { providerId: model.provider, model };

  if (error instanceof AIError) return error;

  if (APICallError.isInstance(error)) {
    // Precedence: an explicit native context-overflow signal beats the HTTP status,
    // because providers report overflow as a generic 400.
    if (hasContextOverflowSignal(error)) {
      return createAIError("AI_CONTEXT_OVERFLOW", undefined, { ...context, cause: error });
    }

    const statusCode = error.statusCode;
    if (statusCode === 401 || statusCode === 403) {
      return createAIError("AI_AUTHENTICATION", undefined, { ...context, cause: error });
    }
    if (statusCode === 429) {
      const retryAfterMs = readRetryAfterMs(error.responseHeaders);
      return createAIError("AI_RATE_LIMIT", undefined, {
        ...context,
        cause: error,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (statusCode !== undefined && statusCode >= 400) {
      return createAIError("AI_PROVIDER_ERROR", undefined, { ...context, cause: error });
    }
    // No HTTP status at all means the request never produced a response.
    return createAIError("AI_NETWORK", undefined, { ...context, cause: error });
  }

  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error)
  ) {
    return createAIError("AI_INVALID_RESPONSE", undefined, { ...context, cause: error });
  }

  // The SDK reports a prompt it cannot build, or a capability it does not have,
  // before any transport is created. Reporting those as a network failure would
  // hide a deterministic request defect behind a retryable code.
  const sdkName = error instanceof Error ? error.name : undefined;
  if (sdkName !== undefined && SDK_ERROR_CODE[sdkName] !== undefined) {
    return createAIError(SDK_ERROR_CODE[sdkName], undefined, { ...context, cause: error });
  }

  if (error instanceof Error) {
    return createAIError("AI_NETWORK", undefined, { ...context, cause: error });
  }
  return createAIError("AI_PROVIDER_ERROR", undefined, { ...context, cause: error });
}

/**
 * SDK errors that are not transport failures, mapped onto the frozen error set.
 *
 * These are keyed by the SDK's own stable error name. They are prompt
 * construction, configuration or capability problems that happen before any
 * provider request, so none of them may be reported as a network failure.
 */
const SDK_ERROR_CODE: Record<string, AIErrorCode> = {
  AI_InvalidPromptError: "AI_INVALID_REQUEST",
  AI_InvalidArgumentError: "AI_INVALID_REQUEST",
  AI_InvalidMessageRoleError: "AI_INVALID_REQUEST",
  AI_MessageConversionError: "AI_INVALID_REQUEST",
  AI_MissingToolResultsError: "AI_INVALID_REQUEST",
  AI_InvalidToolInputError: "AI_INVALID_REQUEST",
  AI_NoSuchToolError: "AI_INVALID_REQUEST",
  AI_UnsupportedFunctionalityError: "AI_CAPABILITY_UNSUPPORTED",
  AI_UnsupportedModelVersionError: "AI_CAPABILITY_UNSUPPORTED",
  AI_LoadAPIKeyError: "AI_AUTHENTICATION",
  AI_NoSuchModelError: "AI_MODEL_UNSUPPORTED",
  AI_NoSuchProviderError: "AI_PROVIDER_NOT_FOUND",
  AI_EmptyResponseBodyError: "AI_INVALID_RESPONSE",
  AI_LoadSettingError: "AI_PROVIDER_ERROR",
  AI_NoContentGeneratedError: "AI_INVALID_RESPONSE",
  AI_StreamProviderError: "AI_PROVIDER_ERROR",
};

/**
 * Look for an explicit native context-overflow signal.
 *
 * The detection order is the frozen one: an explicit native error code first, then
 * a structured error object, then a known explicit message pattern, then a
 * high-confidence heuristic. A generic `400` is never treated as overflow.
 */
function hasContextOverflowSignal(error: APICallError): boolean {
  const candidates: unknown[] = [error.data, error.responseBody];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (containsOverflowCode(candidate)) return true;
      if (containsOverflowMessage(candidate)) return true;
      continue;
    }
    if (candidate === null || typeof candidate !== "object") continue;
    if (objectContainsOverflowCode(candidate)) return true;
  }
  return false;
}

function objectContainsOverflowCode(value: object, depth = 0): boolean {
  if (depth > 4) return false;
  const record = value as { readonly code?: unknown; readonly error?: unknown };

  if (record.code === "context_length_exceeded" || record.code === "LLM_CONTEXT_OVERFLOW")
    return true;
  if (typeof record.error === "string" && containsOverflowCode(record.error)) return true;
  if (record.error !== undefined && record.error !== null && typeof record.error === "object") {
    return objectContainsOverflowCode(record.error, depth + 1);
  }
  return false;
}

function containsOverflowCode(text: string): boolean {
  return /context_length_exceeded|LLM_CONTEXT_OVERFLOW/.test(text);
}

function containsOverflowMessage(text: string): boolean {
  return /context.{0,24}(length|window).{0,24}(exceed|limit)|maximum context length/i.test(text);
}

/**
 * Read a `retry-after` delay in milliseconds.
 *
 * Only the delta-seconds form is honoured. An HTTP-date or an unparsable value is
 * left absent rather than guessed, and a negative delta is rejected because the
 * frozen `retryAfterMs` contract is non-negative.
 */
function readRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (headers === undefined) return undefined;

  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  const raw = entry?.[1]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
