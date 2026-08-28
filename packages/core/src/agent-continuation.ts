import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type { RunId, StepId } from "@caelush/protocol";
import type { AgentFinalCandidateDecision, AgentToolCallsDecision } from "./agent-decision.js";

export interface WaitingToolResultsContinuation {
  readonly type: "WAITING_TOOL_RESULTS";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly receivedResults?: readonly LLMToolResultMessage[];
}

export interface AwaitingVerificationContinuation {
  readonly type: "AWAITING_VERIFICATION";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly finalDecision: AgentFinalCandidateDecision;
}

export type RunContinuationCheckpoint =
  | WaitingToolResultsContinuation
  | AwaitingVerificationContinuation;
