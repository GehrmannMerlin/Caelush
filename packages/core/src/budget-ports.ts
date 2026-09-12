import type { ModelUsage } from "@caelush/ai";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import type { AgentBudgetBlock } from "./agent-errors.js";

/**
 * The AI-agnostic admission input the budget boundary consumes.
 *
 * The durable budget implementation must not need the model invocation contract: it
 * reserves tokens and settles usage, so plain numbers are the whole interface. That
 * keeps `@caelush/storage` free of any dependency on the AI core, which the frozen
 * dependency graph forbids, and it keeps the estimator — which does need the request
 * shape — on the Core side where the request lives.
 */
export interface RunLLMBudgetAdmissionInput {
  readonly estimatedInputTokens?: number;
  readonly configuredMaxOutputTokens?: number;
}

export type RunLLMBudgetAdmission =
  | {
      readonly kind: "ALLOWED";
      /**
       * The output ceiling the budget actually admitted.
       *
       * Absent when the reservation did not change the caller's ceiling. The caller
       * applies it to its own request, so the port never handles a request object.
       */
      readonly effectiveMaxOutputTokens?: number;
    }
  | AgentBudgetBlock;

export type RunBudgetSettlement =
  { readonly kind: "SETTLED" } | Extract<AgentBudgetBlock, { kind: "EXCEEDED" }>;

/** Core-facing budget boundary. Implementations own durable reservation and settlement. */
export interface RunBudgetPort {
  admitLLM(input: {
    readonly run: AgentRun;
    readonly step: AgentStep;
    readonly admission: RunLLMBudgetAdmissionInput;
  }): Promise<RunLLMBudgetAdmission>;
  settleLLM(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly usage?: ModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<RunBudgetSettlement | void>;
  admitVerificationLLM?(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: RunLLMBudgetAdmissionInput;
  }): Promise<RunLLMBudgetAdmission>;
  settleVerificationLLM?(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly usage?: ModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<RunBudgetSettlement | void>;
  markVerificationLLMConservative?(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
  }): Promise<void>;
  markLLMConservative?(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly settledAt: TimestampMs;
  }): Promise<void>;
  reconcileState?(state: AgentState): Promise<AgentState>;
  recover?(runId: RunId, settledAt: TimestampMs): Promise<void>;
}
