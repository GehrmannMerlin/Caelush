import { AIError, createAIError } from "../../errors/ai-error.js";
import { isJsonObject } from "../../json/json-value.js";
import type { AIErrorCode } from "../../errors/ai-error-code.js";
import type { ModelRef } from "../../models/model-ref.js";

/**
 * Normalise any Anthropic Messages failure into the frozen `AIError` set.
 *
 * The mapping is deliberately narrow, because the frozen taxonomy is closed and the
 * adapter may not grow it:
 *
 * ```text
 * 401, 403              -> AI_AUTHENTICATION
 * 413                   -> AI_INVALID_REQUEST     (request bytes, NOT context window)
 * 429 transient         -> AI_RATE_LIMIT          (retryable, with retryAfterMs)
 * 429 spend/usage cap   -> AI_PROVIDER_ERROR      (NOT retryable: a cap is not transient)
 * 504                   -> AI_TIMEOUT
 * 529 overloaded        -> AI_RATE_LIMIT          (the frozen transient-retryable code)
 * explicit context overflow -> AI_CONTEXT_OVERFLOW
 * any other 4xx         -> AI_INVALID_REQUEST
 * any other 5xx         -> AI_PROVIDER_ERROR
 * no HTTP response      -> AI_NETWORK
 * ```
 *
 * No new code is invented: `AI_OVERLOADED`, `AI_PERMISSION` and
 * `AI_REQUEST_TOO_LARGE` do not exist, and `DEFAULT_AI_ERROR_RETRYABILITY` is never
 * modified.
 *
 * A provider body is read for a *classification signal* only. Its text never
 * reaches `AIError.message`: a provider error body can quote the request, and the
 * request carries the system prompt, the tool schema and sometimes a credential.
 */
export interface AnthropicHttpFailure {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

/** Normalise a non-2xx native HTTP response. */
export function normalizeAnthropicHttpError(
  failure: AnthropicHttpFailure,
  model: ModelRef,
): AIError {
  const context = { providerId: model.provider, model };
  const { status } = failure;

  if (status === 401 || status === 403) {
    return createAIError("AI_AUTHENTICATION", undefined, context);
  }

  // 413 is a transport request-size limit. It is not a context-window overflow, and
  // reporting it as one would send a caller down the wrong recovery path.
  if (status === 413) return createAIError("AI_INVALID_REQUEST", undefined, context);

  if (status === 429) {
    if (isSpendCap(failure)) {
      // A spend cap rejects the request deterministically until an operator raises
      // it. The frozen `AI_RATE_LIMIT` is fixed retryable, so a cap must not be
      // reported as one, or a durable retry loop would never terminate.
      return createAIError("AI_PROVIDER_ERROR", undefined, context);
    }
    const retryAfterMs = readRetryAfterMs(failure.headers);
    return createAIError("AI_RATE_LIMIT", undefined, {
      ...context,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  if (status === 504) return createAIError("AI_TIMEOUT", undefined, context);

  // 529 "overloaded" is the native transient-overload signal. The frozen taxonomy has
  // no overload code, and inventing one is forbidden, so it is expressed as the
  // transient retryable rate limit it behaves like.
  if (status === 529) return createAIError("AI_RATE_LIMIT", undefined, context);

  if (status >= 500) return createAIError("AI_PROVIDER_ERROR", undefined, context);

  if (status >= 400) {
    // A generic 400 is a generic invalid request. Only an explicit native overflow
    // signal — never the status alone — becomes AI_CONTEXT_OVERFLOW.
    if (hasContextOverflowSignal(failure.bodyText)) {
      return createAIError("AI_CONTEXT_OVERFLOW", undefined, context);
    }
    return createAIError("AI_INVALID_REQUEST", undefined, context);
  }

  return createAIError("AI_PROVIDER_ERROR", undefined, context);
}

/** A mid-stream native `error` event, whose payload is already a JSON object. */
export function normalizeAnthropicStreamError(payload: unknown, model: ModelRef): AIError {
  const context = { providerId: model.provider, model };
  const record = isJsonObject(payload) ? payload : undefined;
  const error = record !== undefined && isJsonObject(record["error"]) ? record["error"] : record;
  const type = typeof error?.["type"] === "string" ? error["type"] : undefined;
  const message = typeof error?.["message"] === "string" ? error["message"] : "";

  return createAIError(codeForNativeType(type, message), undefined, context);
}

/** What a fetch failure means: an abort when the gateway signal fired, else network. */
export function normalizeAnthropicFetchFailure(
  error: unknown,
  aborted: boolean,
  model: ModelRef,
): AIError {
  const context = { providerId: model.provider, model, cause: error };
  if (error instanceof AIError) return error;
  // The gateway owns abort semantics; this is the adapter's backstop for a transport
  // that reports the cancellation as its own error. Reading the signal is what makes
  // the distinction, never the error's text or name.
  if (aborted || isAbortError(error)) return createAIError("AI_ABORTED", undefined, context);
  return createAIError("AI_NETWORK", undefined, context);
}

/** The platform abort error, recognised by its own standard name. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A malformed native payload: unparsable JSON, a wrong shape, a bad tool input. */
export function normalizeAnthropicInvalidResponse(
  error: unknown,
  model: ModelRef,
  message: string,
): AIError {
  if (error instanceof AIError) return error;
  return createAIError("AI_INVALID_RESPONSE", message, {
    providerId: model.provider,
    model,
    cause: error,
  });
}

/** Map a native error `type` onto a frozen code. */
function codeForNativeType(type: string | undefined, message: string): AIErrorCode {
  switch (type) {
    case "authentication_error":
    case "permission_error":
      return "AI_AUTHENTICATION";
    case "rate_limit_error":
      return "AI_RATE_LIMIT";
    case "overloaded_error":
      return "AI_RATE_LIMIT";
    case "timeout_error":
      return "AI_TIMEOUT";
    case "request_too_large":
      return "AI_INVALID_REQUEST";
    case "invalid_request_error":
      return hasContextOverflowSignal(message) ? "AI_CONTEXT_OVERFLOW" : "AI_INVALID_REQUEST";
    case "api_error":
      return "AI_PROVIDER_ERROR";
    default:
      return hasContextOverflowSignal(message) ? "AI_CONTEXT_OVERFLOW" : "AI_PROVIDER_ERROR";
  }
}

/**
 * Detect an explicit native context-overflow signal.
 *
 * The check is high-confidence only. A generic 400 or an unclassified error is never
 * treated as overflow, because the frozen `AI_CONTEXT_OVERFLOW` is non-retryable and
 * a caller reacts to it by compacting its context: a false positive would throw away
 * a valid conversation.
 */
function hasContextOverflowSignal(bodyText: string): boolean {
  if (bodyText.length === 0) return false;
  return /context[_ ]?(length|window)|prompt is too long|too many tokens|maximum context/i.test(
    bodyText,
  );
}

/**
 * Detect a spend or usage cap reported as a 429.
 *
 * A spend cap shares the status code with a transient rate limit but is not
 * transient: the request is rejected until quota is restored, which for a durable
 * run means forever. Detection requires an explicit cap phrase in the body, so an
 * ordinary rate limit is never misclassified.
 */
function isSpendCap(failure: AnthropicHttpFailure): boolean {
  const text = failure.bodyText;
  if (text.length === 0) return false;
  const capPhrase =
    /(spend|usage|credit|billing|quota)[ _-]?(limit|cap)|exceeded your (current )?(spend|usage|quota|credit)|insufficient (credit|quota|balance)|out of credits/i;
  if (capPhrase.test(text)) return true;

  // An explicit non-transient retry hint also identifies a permanent rejection.
  return /"type"\s*:\s*"(spend|usage|quota)_limit_error"/i.test(text);
}

/**
 * Read a `retry-after` delay in milliseconds.
 *
 * Only the delta-seconds form is honoured. An HTTP-date or an unparsable value is
 * left absent rather than guessed, so the frozen schema keeps `undefined` instead of
 * a fabricated delay.
 */
function readRetryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  const raw = entry?.[1]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
