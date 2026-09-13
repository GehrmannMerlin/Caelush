/**
 * The frozen failure contract of one model turn execution.
 *
 * `ModelTurnExecutor.execute()` never throws for a model outcome. It resolves a
 * {@link ModelTurnExecutionResult} instead, so the durable run layer receives data it
 * can classify, persist and retry on rather than an exception it has to interpret.
 *
 * The code set is closed on purpose. Everything the AI core can report must reduce to
 * one of these codes, and an unsupported or unclassified failure must not invent a new
 * one at runtime.
 */

import type { AIError } from "@caelush/ai";

/**
 * Why a model turn failed.
 *
 * Mapping from the frozen AI error codes:
 *
 * ```text
 * AI_AUTHENTICATION            → AUTHENTICATION
 * AI_RATE_LIMIT                → RATE_LIMIT
 * AI_NETWORK                   → NETWORK
 * AI_TIMEOUT                   → TIMEOUT
 * AI_CONTEXT_OVERFLOW          → CONTEXT_OVERFLOW
 * AI_PROVIDER_ERROR            → PROVIDER_ERROR
 * AI_PROVIDER_NOT_FOUND        → PROVIDER_ERROR
 * AI_ADAPTER_NOT_FOUND         → PROVIDER_ERROR
 * AI_INVALID_REQUEST           → INVALID_RESPONSE
 * AI_INVALID_RESPONSE          → INVALID_RESPONSE
 * AI_MODEL_UNSUPPORTED         → UNSUPPORTED_MODEL
 * AI_MODEL_METADATA_INCOMPLETE → UNSUPPORTED_MODEL
 * AI_CAPABILITY_UNSUPPORTED    → UNSUPPORTED_CAPABILITY
 *
 * AI_ABORTED                   → CANCELLED, which is a result kind and never an error
 * ```
 *
 * The three codes the freeze table does not name — `AI_PROVIDER_NOT_FOUND`,
 * `AI_ADAPTER_NOT_FOUND` and `AI_INVALID_REQUEST` — are folded into `PROVIDER_ERROR`,
 * `PROVIDER_ERROR` and `INVALID_RESPONSE`. They are configuration and request-shape
 * failures, not model-support failures, and the closed set stays closed: adding a
 * `PROVIDER_NOT_FOUND` code here would be a second provider-not-found authority next to
 * the AI core's own.
 */
export type ModelTurnExecutionErrorCode =
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "NETWORK"
  | "TIMEOUT"
  | "CONTEXT_OVERFLOW"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_MODEL"
  | "UNSUPPORTED_CAPABILITY";

/** Every frozen failure code, in canonical order. */
export const MODEL_TURN_EXECUTION_ERROR_CODES = [
  "AUTHENTICATION",
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
  "CONTEXT_OVERFLOW",
  "PROVIDER_ERROR",
  "INVALID_RESPONSE",
  "UNSUPPORTED_MODEL",
  "UNSUPPORTED_CAPABILITY",
] as const satisfies readonly ModelTurnExecutionErrorCode[];

/**
 * Which failure codes describe a transient provider condition.
 *
 * This is information for the durable run layer, never a retry decision: the agent
 * kernel does not retry, sleep or back off, and Run Retry Policy owns the outcome.
 *
 * `CONTEXT_OVERFLOW` is deliberately not retryable. It is recovered by one forced
 * context recovery inside the loop, which is a different mechanism from a provider
 * retry.
 */
export const RETRYABLE_MODEL_TURN_ERROR_CODES = [
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
] as const satisfies readonly ModelTurnExecutionErrorCode[];

/**
 * A sanitized model turn failure.
 *
 * It carries no cause, no stack and no provider payload. `message` must already be a
 * safe summary: a provider body, a prompt, a tool argument or a credential must never
 * reach this boundary.
 */
export interface ModelTurnExecutionError {
  readonly code: ModelTurnExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** A bounded provider hint in milliseconds, when one was reported safely. */
  readonly retryAfterMs?: number;
  /**
   * Which stage of the turn failed, when the executor did not fail at the provider itself.
   *
   * An executor may be composed with an admission step or a durable boundary of its own, in
   * which case it reports the stage it failed at rather than a context-free provider failure.
   * Absent means the model turn itself failed.
   */
  readonly stage?: "ADMISSION" | "BOUNDARY" | "MODEL";
  /**
   * The original failure, for a host boundary that must classify it again.
   *
   * It is a local debugging and classification channel only. It is never serialized, never
   * becomes a durable field, and never contributes to `message`: a throw may carry a provider
   * body, a prompt or a credential, and none of that may cross a public boundary. The Core
   * compatibility facade uses it to re-derive the legacy error classification its own mapper
   * already implements.
   */
  readonly cause?: unknown;
}

/** True when the code describes a transient provider condition. */
export function isRetryableModelTurnErrorCode(code: ModelTurnExecutionErrorCode): boolean {
  return (RETRYABLE_MODEL_TURN_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Map a frozen AI error code onto the frozen model-turn failure code.
 *
 * It is exhaustive over `AIErrorCode`, so a new AI error code cannot be added without this
 * mapping being revisited. It lives with the failure contract rather than inside the executor
 * because the Core compatibility boundary needs the same mapping when it reconstructs a frozen
 * failure from a legacy throw.
 */
export function toModelTurnExecutionErrorCode(code: AIError["code"]): ModelTurnExecutionErrorCode {
  switch (code) {
    case "AI_AUTHENTICATION":
      return "AUTHENTICATION";
    case "AI_RATE_LIMIT":
      return "RATE_LIMIT";
    case "AI_NETWORK":
      return "NETWORK";
    case "AI_TIMEOUT":
      return "TIMEOUT";
    case "AI_CONTEXT_OVERFLOW":
      return "CONTEXT_OVERFLOW";
    case "AI_MODEL_UNSUPPORTED":
    case "AI_MODEL_METADATA_INCOMPLETE":
      return "UNSUPPORTED_MODEL";
    case "AI_CAPABILITY_UNSUPPORTED":
      return "UNSUPPORTED_CAPABILITY";
    case "AI_INVALID_RESPONSE":
    case "AI_INVALID_REQUEST":
      return "INVALID_RESPONSE";
    case "AI_ABORTED":
      // Reaching here without the cancellation path would be a mapping bug. The code is
      // accepted so the mapping stays exhaustive, and the outcome is a provider failure
      // rather than a silently dropped turn.
      return "PROVIDER_ERROR";
    case "AI_PROVIDER_ERROR":
    case "AI_PROVIDER_NOT_FOUND":
    case "AI_ADAPTER_NOT_FOUND":
      return "PROVIDER_ERROR";
    default:
      return assertUnmappedCode(code);
  }
}

function assertUnmappedCode(code: never): never {
  throw new TypeError(`Unmapped AI error code: ${String(code)}`);
}
