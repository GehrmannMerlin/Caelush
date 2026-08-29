import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type { RunId, StepId, ToolInvocationId, ToolName } from "@caelush/protocol";
import type { AgentFinalCandidateDecision, AgentToolCallsDecision } from "./agent-decision.js";

export interface WaitingToolResultsContinuation {
  readonly type: "WAITING_TOOL_RESULTS";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly receivedResults?: readonly LLMToolResultMessage[] | undefined;
  readonly waitingApproval?:
    | {
        readonly invocationId: ToolInvocationId;
        readonly externalCallId: string;
        readonly toolName: ToolName;
      }
    | undefined;
}

export interface AwaitingVerificationContinuation {
  readonly type: "AWAITING_VERIFICATION";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly finalDecision: AgentFinalCandidateDecision;
}

export type RunContinuationCheckpoint =
  WaitingToolResultsContinuation | AwaitingVerificationContinuation;
