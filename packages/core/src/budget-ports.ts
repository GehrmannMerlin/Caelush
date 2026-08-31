import type { LLMRequest } from "@caelush/llm/request";
import type { LLMUsage } from "@caelush/llm/turn";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import type { AgentBudgetBlock } from "./agent-errors.js";

export type RunLLMBudgetAdmission =
  | {
      readonly kind: "ALLOWED";
      readonly request: LLMRequest;
    }
  | AgentBudgetBlock;

export type RunBudgetSettlement =
  { readonly kind: "SETTLED" } | Extract<AgentBudgetBlock, { kind: "EXCEEDED" }>;

/** Core-facing budget boundary. Implementations own durable reservation and settlement. */
export interface RunBudgetPort {
  admitLLM(input: {
    readonly run: AgentRun;
    readonly step: AgentStep;
    readonly request: LLMRequest;
  }): Promise<RunLLMBudgetAdmission>;
  settleLLM(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly usage?: LLMUsage;
    readonly settledAt: TimestampMs;
  }): Promise<RunBudgetSettlement | void>;
  admitVerificationLLM?(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly request: LLMRequest;
  }): Promise<RunLLMBudgetAdmission>;
  settleVerificationLLM?(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly usage?: LLMUsage;
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
