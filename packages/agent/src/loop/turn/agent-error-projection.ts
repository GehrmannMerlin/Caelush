import type { AgentError, AgentErrorCode } from "@caelush/protocol";

import type { AgentBudgetBlock } from "../ports/model-request-admission.js";
import type { ModelTurnExecutionError, ModelTurnExecutionErrorCode } from "./model-turn-error.js";

/**
 * The single deterministic projection from a kernel failure onto the durable `AgentError`.
 *
 * The two vocabularies are deliberately distinct and neither replaces the other:
 *
 * ```text
 * ModelTurnExecutionError   what one model turn did, in the kernel's closed code set
 * AgentError                the canonical Protocol failure a durable Run settles with
 * ```
 *
 * The freeze keeps them apart on purpose, so the kernel never claims a Run-level meaning
 * and the Run Layer never has to read a provider-shaped value. There is exactly one
 * mapping, and it is total over the closed code set: a new model-turn code cannot be added
 * without this projection being revisited, which is what stops the durable vocabulary from
 * silently drifting away from the kernel's.
 *
 * The table is stable and externally meaningful:
 *
 * ```text
 * AUTHENTICATION          → MODEL_ERROR        deterministic provider configuration failure
 * RATE_LIMIT              → RATE_LIMIT         transient, retryable
 * NETWORK                 → NETWORK_ERROR      transient, retryable
 * TIMEOUT                 → MODEL_TIMEOUT      transient, retryable
 * CONTEXT_OVERFLOW        → CONTEXT_EXHAUSTED  the window could not be recovered
 * INVALID_RESPONSE        → MODEL_ERROR        the provider answered unusably
 * PROVIDER_ERROR          → MODEL_ERROR        an unclassified provider problem
 * UNSUPPORTED_MODEL       → MODEL_ERROR        deterministic
 * UNSUPPORTED_CAPABILITY  → MODEL_ERROR        deterministic
 * ```
 */
export function toAgentError(error: ModelTurnExecutionError): AgentError {
  return {
    code: toAgentErrorCode(error.code),
    message: error.message,
    retryable: error.retryable,
    phase: "LLM",
  };
}

/**
 * Project a durable budget refusal onto the canonical future-settlement error.
 *
 * `UNAVAILABLE` is not `EXCEEDED`: failing to establish enforcement at all is a fail-closed
 * configuration outcome, and reporting it as an exceeded budget would tell the Run Layer
 * that a limit was spent when none was ever applied.
 */
export function toBudgetAgentError(block: AgentBudgetBlock): AgentError {
  return block.kind === "UNAVAILABLE"
    ? {
        code: "BUDGET_ENFORCEMENT_UNAVAILABLE",
        message: "Budget enforcement is unavailable for this model turn.",
        retryable: false,
        phase: "LLM",
      }
    : {
        code: "BUDGET_EXCEEDED",
        message: "The configured Run budget would be exceeded.",
        retryable: false,
        phase: "LLM",
      };
}

/** Map one frozen model-turn code onto the canonical Protocol failure code. */
export function toAgentErrorCode(code: ModelTurnExecutionErrorCode): AgentErrorCode {
  switch (code) {
    case "RATE_LIMIT":
      return "RATE_LIMIT";
    case "NETWORK":
      return "NETWORK_ERROR";
    case "TIMEOUT":
      return "MODEL_TIMEOUT";
    case "CONTEXT_OVERFLOW":
      return "CONTEXT_EXHAUSTED";
    case "AUTHENTICATION":
    case "PROVIDER_ERROR":
    case "INVALID_RESPONSE":
    case "UNSUPPORTED_MODEL":
    case "UNSUPPORTED_CAPABILITY":
      return "MODEL_ERROR";
    default:
      return assertUnmappedCode(code);
  }
}

function assertUnmappedCode(code: never): never {
  throw new TypeError(`Unmapped model turn error code: ${String(code)}`);
}
