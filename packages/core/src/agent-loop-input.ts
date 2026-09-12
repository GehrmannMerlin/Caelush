import type {
  ContextBuildLimits,
  ContextBuildReport,
  VerificationRepairContextInput,
} from "@caelush/context";
import type { LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import type { AIModelRequest, AIModelTurnResult, AIToolChoice, ModelUsage } from "@caelush/ai";
import type {
  AgentError,
  AgentRun,
  AgentState,
  AgentStep,
  StepId,
  TimestampMs,
  ToolDefinition,
} from "@caelush/protocol";
import type { AgentToolCallsDecision, AgentLoopOutcome } from "./agent-decision.js";
import type { AgentBudgetBlock } from "./agent-errors.js";
import type { AgentLoopDependencies, AgentProviderTurnState } from "./agent-loop-ports.js";

export interface AgentRetryMetadata {
  readonly code: "AI_RATE_LIMIT" | "AI_NETWORK" | "AI_TIMEOUT";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface AgentLoopModelSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly toolChoice?: AIToolChoice;
}

export interface AgentLoopCommonInput {
  readonly signal: AbortSignal;
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly history: readonly LLMMessage[];
  /** Durable conversation sequence values aligned with history when available. */
  readonly historySourceSequences?: readonly number[];
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly tools?: readonly ToolDefinition[];
  readonly modelSettings?: AgentLoopModelSettings;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
  readonly verificationRepairContext?: VerificationRepairContextInput;
}

export type AgentLoopStartInput = AgentLoopCommonInput;

export interface AgentLoopResumeInput extends AgentLoopCommonInput {
  readonly pendingDecision: AgentToolCallsDecision;
  readonly toolResults: readonly LLMToolResultMessage[];
}

export interface AgentLoopOutcomeResult {
  readonly status: "OUTCOME";
  readonly outcome: AgentLoopOutcome;
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: AgentProviderTurnState;
}

export interface AgentLoopFailureResult {
  readonly status: "FAILED";
  readonly error: AgentError;
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: AgentProviderTurnState;
  readonly retry?: AgentRetryMetadata;
  readonly budget?: AgentBudgetBlock;
  readonly usage?: ModelUsage;
}

export interface AgentLoopCancelledResult {
  readonly status: "CANCELLED";
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: "NOT_STARTED" | "CANCELLED";
}

export type AgentLoopExecutionResult =
  AgentLoopOutcomeResult | AgentLoopFailureResult | AgentLoopCancelledResult;

export type AgentLoopRequest = AIModelRequest;
export type AgentLoopTurn = AIModelTurnResult;
export type AgentLoopTimestamp = TimestampMs;
export type AgentLoopStepId = StepId;

export type { AgentLoopDependencies };
