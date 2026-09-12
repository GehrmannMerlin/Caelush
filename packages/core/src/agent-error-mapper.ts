import { ContextBudgetExceededError, ContextError, ContextExhaustedError } from "@caelush/context";
import type { AIError, AIErrorCode } from "@caelush/ai";
import type { AgentRetryMetadata } from "./agent-loop-input.js";
import type { AgentError } from "@caelush/protocol";
import { AgentErrorSchema } from "@caelush/protocol";
import {
  AgentBudgetAdmissionError,
  AgentModelOutputError,
  AgentToolResultBatchError,
} from "./agent-errors.js";

/**
 * AI failure codes that describe a transient provider condition.
 *
 * Only these may carry retry metadata to the durable run layer. Every other code is
 * a deterministic outcome, and retrying it would repeat the same failure.
 */
const RETRYABLE_AI_CODES = ["AI_RATE_LIMIT", "AI_NETWORK", "AI_TIMEOUT"] as const;

/** Every frozen AI error code, so the structural check cannot accept a foreign code. */
const ALL_AI_CODES: readonly string[] = [
  ...RETRYABLE_AI_CODES,
  "AI_PROVIDER_NOT_FOUND",
  "AI_MODEL_UNSUPPORTED",
  "AI_MODEL_METADATA_INCOMPLETE",
  "AI_ADAPTER_NOT_FOUND",
  "AI_CAPABILITY_UNSUPPORTED",
  "AI_INVALID_REQUEST",
  "AI_AUTHENTICATION",
  "AI_CONTEXT_OVERFLOW",
  "AI_ABORTED",
  "AI_INVALID_RESPONSE",
  "AI_PROVIDER_ERROR",
];

export function mapAgentLoopError(error: unknown): AgentError {
  if (error instanceof AgentBudgetAdmissionError) {
    return error.block.kind === "UNAVAILABLE"
      ? agentError(
          "BUDGET_ENFORCEMENT_UNAVAILABLE",
          "LLM",
          false,
          "Budget enforcement is unavailable for this model turn.",
        )
      : agentError("BUDGET_EXCEEDED", "LLM", false, "The configured Run budget would be exceeded.");
  }
  if (error instanceof AgentToolResultBatchError) {
    return agentError("TOOL_OUTPUT_ERROR", "TOOL", false, "The tool result batch was invalid.");
  }
  if (error instanceof AgentModelOutputError) {
    return agentError("MODEL_ERROR", "LLM", false, "The model turn could not be completed.");
  }
  if (error instanceof ContextBudgetExceededError) {
    return agentError(
      "BUDGET_EXCEEDED",
      "RUNTIME",
      false,
      "The model context exceeds the configured input budget.",
    );
  }
  if (error instanceof ContextExhaustedError) {
    return agentError(
      "CONTEXT_EXHAUSTED",
      "RUNTIME",
      false,
      "The model context could not be recovered after compaction.",
    );
  }
  if (error instanceof ContextError) {
    return agentError(
      "INTERNAL_ERROR",
      "INTERNAL",
      false,
      "The agent loop encountered an internal error.",
    );
  }

  const aiError = asAIError(error);
  if (aiError === undefined) {
    return agentError(
      "INTERNAL_ERROR",
      "INTERNAL",
      false,
      "The agent loop encountered an internal error.",
    );
  }

  switch (aiError.code) {
    case "AI_RATE_LIMIT":
      return agentError(
        "RATE_LIMIT",
        "LLM",
        aiError.retryable,
        "The model provider rate limit was reached.",
      );
    case "AI_NETWORK":
      return agentError(
        "NETWORK_ERROR",
        "LLM",
        aiError.retryable,
        "The model provider could not be reached.",
      );
    case "AI_TIMEOUT":
      return agentError(
        "MODEL_TIMEOUT",
        "LLM",
        aiError.retryable,
        "The model provider request timed out.",
      );
    case "AI_ABORTED":
      return agentError("CANCELLED", "LLM", false, "The model turn was cancelled.");
    default:
      // Authentication, unsupported model, incomplete metadata, unsupported
      // capability, invalid request, context overflow, invalid response and generic
      // provider failures are deterministic: never marked as a durable retry.
      return agentError("MODEL_ERROR", "LLM", false, "The model turn could not be completed.");
  }
}

/**
 * Derive retry metadata for the durable run layer.
 *
 * Only `AI_RATE_LIMIT`, `AI_NETWORK` and `AI_TIMEOUT` qualify. This function decides
 * nothing about retrying: it reports what the AI core already said, and the run retry
 * policy owns the decision.
 */
export function mapAgentRetryMetadata(error: unknown): AgentRetryMetadata | undefined {
  const aiError = asAIError(error);
  if (aiError === undefined || !aiError.retryable) return undefined;

  const code = aiError.code;
  if (code !== "AI_RATE_LIMIT" && code !== "AI_NETWORK" && code !== "AI_TIMEOUT") return undefined;

  return {
    code,
    retryable: aiError.retryable,
    ...(aiError.retryAfterMs === undefined ? {} : { retryAfterMs: aiError.retryAfterMs }),
  };
}

/**
 * True when the failure is a cancellation rather than a model failure.
 *
 * A model turn that reports `AI_ABORTED` follows the `CANCELLED` path: it must never
 * become a failed provider attempt carrying retry metadata.
 */
export function isAIAbortError(error: unknown): boolean {
  return asAIError(error)?.code === "AI_ABORTED";
}

/**
 * Read an AI failure structurally.
 *
 * A structural read keeps the mapping working even if two module instances of the AI
 * core ever coexist, and the closed code list keeps a foreign `{code, retryable}`
 * object from being mistaken for an AI failure.
 */
function asAIError(error: unknown): AIError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { readonly code?: unknown; readonly retryable?: unknown };
  if (typeof candidate.retryable !== "boolean") return undefined;
  if (typeof candidate.code !== "string" || !ALL_AI_CODES.includes(candidate.code)) return undefined;
  return candidate as AIError;
}

function agentError(
  code: AgentError["code"],
  phase: NonNullable<AgentError["phase"]>,
  retryable: boolean,
  message: string,
): AgentError {
  return AgentErrorSchema.parse({ code, phase, retryable, message });
}

/** The frozen AI error code type, re-exported for callers that need to name a code. */
export type { AIErrorCode };
