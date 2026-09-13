import type { AgentDecision } from "../loop/decision/decision.js";
import type {
  AgentLoopFailureStage,
  AgentLoopAdvanceResult,
  AIUserInputMessage,
} from "../loop/types.js";
import type { RunExecutionBudgetBlock, RunExecutionError, RunExecutionMode } from "./directive.js";

/**
 * What one executed effect produced.
 *
 * ```text
 * AGENT       a model turn settled into a decision, or failed with a typed stage
 * TOOLS       a Tool batch boundary settled into a typed Tool turn result
 * COMPLETION  a Completion Gate evaluated a final candidate
 * NONE        the effect produced no state change
 * ```
 *
 * The union is deliberately narrow. A driver may not report a Run status, a Step settlement or a
 * durable commit: those are the RunController's, and a driver that could report them would be a
 * second lifecycle authority.
 */
export type RunExecutionEffectResult =
  | RunExecutionAgentEffect
  | RunExecutionToolsEffect
  | RunExecutionCompletionEffect
  | RunExecutionNoneEffect;

/** A model turn effect. */
export interface RunExecutionAgentEffect {
  readonly kind: "AGENT";
  readonly mode: RunExecutionMode;
  readonly outcome:
    | { readonly status: "DECIDED"; readonly decision: AgentDecision }
    | {
        readonly status: "FAILED";
        readonly stage: AgentLoopFailureStage;
        readonly error: RunExecutionError;
        readonly retryable: boolean;
        readonly retryAfterMs?: number;
        readonly budgetBlock?: RunExecutionBudgetBlock;
      }
    | { readonly status: "CANCELLED" };
}

/** The Tool turn results a batch boundary can settle into. */
export type RunExecutionToolTurnResult =
  | { readonly kind: "COMPLETED" }
  | { readonly kind: "WAITING_APPROVAL" }
  | { readonly kind: "BUDGET_EXCEEDED"; readonly block: RunExecutionBudgetBlock }
  | { readonly kind: "RESOURCE_WAIT" }
  | { readonly kind: "REPLAN" };

/** A Tool batch effect. */
export interface RunExecutionToolsEffect {
  readonly kind: "TOOLS";
  readonly result: RunExecutionToolTurnResult;
}

/** A completion evaluation effect. */
export interface RunExecutionCompletionEffect {
  readonly kind: "COMPLETION";
  readonly decision:
    | { readonly outcome: "ACCEPT" }
    | { readonly outcome: "REPAIR"; readonly repairRef: string; readonly cycle: number }
    | { readonly outcome: "REJECT"; readonly reason: string }
    | { readonly outcome: "ERROR"; readonly error: RunExecutionError };
}

/** An effect that changed nothing. */
export interface RunExecutionNoneEffect {
  readonly kind: "NONE";
  readonly reason: string;
}

/** The messages a caller may append durably after an agent effect. */
export type RunExecutionAppendMessages = readonly AIUserInputMessage[];

export type { AgentLoopAdvanceResult };
