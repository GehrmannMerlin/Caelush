/**
 * The frozen AI error codes.
 *
 * Every failure the AI core can report is exactly one of these. A provider or
 * adapter error is always normalised into this closed set before it crosses the
 * AI boundary.
 */
export type AIErrorCode =
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_MODEL_UNSUPPORTED"
  | "AI_MODEL_METADATA_INCOMPLETE"
  | "AI_ADAPTER_NOT_FOUND"
  | "AI_CAPABILITY_UNSUPPORTED"
  | "AI_INVALID_REQUEST"
  | "AI_AUTHENTICATION"
  | "AI_RATE_LIMIT"
  | "AI_NETWORK"
  | "AI_TIMEOUT"
  | "AI_CONTEXT_OVERFLOW"
  | "AI_ABORTED"
  | "AI_INVALID_RESPONSE"
  | "AI_PROVIDER_ERROR";

/** Every frozen code, in canonical order. */
export const AI_ERROR_CODES = [
  "AI_PROVIDER_NOT_FOUND",
  "AI_MODEL_UNSUPPORTED",
  "AI_MODEL_METADATA_INCOMPLETE",
  "AI_ADAPTER_NOT_FOUND",
  "AI_CAPABILITY_UNSUPPORTED",
  "AI_INVALID_REQUEST",
  "AI_AUTHENTICATION",
  "AI_RATE_LIMIT",
  "AI_NETWORK",
  "AI_TIMEOUT",
  "AI_CONTEXT_OVERFLOW",
  "AI_ABORTED",
  "AI_INVALID_RESPONSE",
  "AI_PROVIDER_ERROR",
] as const satisfies readonly AIErrorCode[];

/**
 * Frozen default retryability.
 *
 * Only `AI_RATE_LIMIT`, `AI_NETWORK` and `AI_TIMEOUT` are retryable. Everything
 * else is a deterministic outcome: retrying it would repeat the same failure.
 * Note that `AI_PROVIDER_ERROR` and `AI_CONTEXT_OVERFLOW` are deliberately *not*
 * retryable, and that the AI core itself never retries — the flag is information
 * for the caller.
 */
export const DEFAULT_AI_ERROR_RETRYABILITY: Record<AIErrorCode, boolean> = {
  AI_PROVIDER_NOT_FOUND: false,
  AI_MODEL_UNSUPPORTED: false,
  AI_MODEL_METADATA_INCOMPLETE: false,
  AI_ADAPTER_NOT_FOUND: false,
  AI_CAPABILITY_UNSUPPORTED: false,
  AI_INVALID_REQUEST: false,
  AI_AUTHENTICATION: false,
  AI_RATE_LIMIT: true,
  AI_NETWORK: true,
  AI_TIMEOUT: true,
  AI_CONTEXT_OVERFLOW: false,
  AI_ABORTED: false,
  AI_INVALID_RESPONSE: false,
  AI_PROVIDER_ERROR: false,
};

/** A safe, credential-free default message for every code. */
export const AI_ERROR_DEFAULT_MESSAGES: Record<AIErrorCode, string> = {
  AI_PROVIDER_NOT_FOUND: "AI provider is not configured.",
  AI_MODEL_UNSUPPORTED: "AI provider does not support the requested model.",
  AI_MODEL_METADATA_INCOMPLETE: "AI model metadata is incomplete.",
  AI_ADAPTER_NOT_FOUND: "No API adapter is registered for the requested dialect.",
  AI_CAPABILITY_UNSUPPORTED: "AI model does not support the requested capability.",
  AI_INVALID_REQUEST: "AI model request is invalid.",
  AI_AUTHENTICATION: "AI provider authentication failed.",
  AI_RATE_LIMIT: "AI provider rate limit exceeded.",
  AI_NETWORK: "AI provider network request failed.",
  AI_TIMEOUT: "AI provider request timed out.",
  AI_CONTEXT_OVERFLOW: "AI provider rejected the request because the context window was exceeded.",
  AI_ABORTED: "AI provider request was aborted.",
  AI_INVALID_RESPONSE: "AI provider returned an invalid response.",
  AI_PROVIDER_ERROR: "AI provider request failed.",
};

/** True when the value is one of the frozen error codes. */
export function isAIErrorCode(value: unknown): value is AIErrorCode {
  return typeof value === "string" && (AI_ERROR_CODES as readonly string[]).includes(value);
}
