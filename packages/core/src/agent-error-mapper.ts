import { ContextBudgetExceededError, ContextError, ContextExhaustedError } from "@caelush/context";
import { LLMError, LLMNetworkError, LLMRateLimitError, LLMTimeoutError } from "@caelush/llm/errors";
import type { AgentRetryMetadata } from "./agent-loop-input.js";
import type { AgentError } from "@caelush/protocol";
import { AgentErrorSchema } from "@caelush/protocol";
import {
  AgentBudgetAdmissionError,
  AgentModelOutputError,
  AgentToolResultBatchError,
} from "./agent-errors.js";

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
  if (error instanceof LLMNetworkError) {
    return agentError(
      "NETWORK_ERROR",
      "LLM",
      error.retryable,
      "The model provider could not be reached.",
    );
  }
  if (error instanceof LLMRateLimitError) {
    return agentError(
      "RATE_LIMIT",
      "LLM",
      error.retryable,
      "The model provider rate limit was reached.",
    );
  }
  if (error instanceof LLMTimeoutError) {
    return agentError(
      "MODEL_TIMEOUT",
      "LLM",
      error.retryable,
      "The model provider request timed out.",
    );
  }
  if (error instanceof LLMError) {
    return agentError("MODEL_ERROR", "LLM", false, "The model turn could not be completed.");
  }
  return agentError(
    "INTERNAL_ERROR",
    "INTERNAL",
    false,
    "The agent loop encountered an internal error.",
  );
}

export function mapAgentRetryMetadata(error: unknown): AgentRetryMetadata | undefined {
  if (!(error instanceof LLMError) || !error.retryable) return undefined;
  if (
    error.code !== "LLM_RATE_LIMIT" &&
    error.code !== "LLM_NETWORK" &&
    error.code !== "LLM_TIMEOUT"
  ) {
    return undefined;
  }
  return {
    code: error.code,
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

function agentError(
  code: AgentError["code"],
  phase: NonNullable<AgentError["phase"]>,
  retryable: boolean,
  message: string,
): AgentError {
  return AgentErrorSchema.parse({ code, phase, retryable, message });
}
