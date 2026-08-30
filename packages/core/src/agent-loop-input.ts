import type { ContextBuildLimits, ContextBuildReport } from "@caelush/context";
import type { LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import type { LLMToolChoice, LLMRequest } from "@caelush/llm/request";
import type { LLMTurnResult } from "@caelush/llm/turn";
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
import type { AgentLoopDependencies, AgentProviderTurnState } from "./agent-loop-ports.js";

export interface AgentLoopModelSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly toolChoice?: LLMToolChoice;
}

export interface AgentLoopCommonInput {
  readonly signal: AbortSignal;
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly history: readonly LLMMessage[];
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly tools?: readonly ToolDefinition[];
  readonly modelSettings?: AgentLoopModelSettings;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
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
  | AgentLoopOutcomeResult
  | AgentLoopFailureResult
  | AgentLoopCancelledResult;

export type AgentLoopRequest = LLMRequest;
export type AgentLoopTurn = LLMTurnResult;
export type AgentLoopTimestamp = TimestampMs;
export type AgentLoopStepId = StepId;

export type { AgentLoopDependencies };
