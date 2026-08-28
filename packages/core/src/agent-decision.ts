import type { LLMAssistantMessage } from "@caelush/llm/messages";
import type { FinishReason, LLMUsage } from "@caelush/llm/turn";
import type { JsonObject, LLMCallId, ModelRef, ToolName } from "@caelush/protocol";

export interface AgentModelTurn {
  readonly callId: LLMCallId;
  readonly model: ModelRef;
  readonly finishReason: FinishReason;
  readonly assistantMessage: LLMAssistantMessage;
  readonly usage?: LLMUsage;
}

export interface AgentToolRequest {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

export interface AgentToolCallsDecision {
  readonly type: "TOOL_CALLS_REQUESTED";
  readonly modelTurn: AgentModelTurn;
  readonly toolRequests: readonly AgentToolRequest[];
}

export interface AgentFinalCandidateDecision {
  readonly type: "FINAL_CANDIDATE";
  readonly modelTurn: AgentModelTurn;
  readonly candidateText: string;
}

export type AgentDecision = AgentToolCallsDecision | AgentFinalCandidateDecision;

export interface AgentMaxStepsReachedOutcome {
  readonly type: "MAX_STEPS_REACHED";
  readonly stepsCompleted: number;
  readonly maxSteps: number;
}

export type AgentLoopOutcome = AgentDecision | AgentMaxStepsReachedOutcome;
