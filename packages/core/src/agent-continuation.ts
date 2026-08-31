import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type {
  ApprovalRequestId,
  RunId,
  StepId,
  ToolInvocationId,
  ToolName,
  VerificationCheckId,
  VerificationEvidenceId,
  VerificationPlanId,
} from "@caelush/protocol";
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
        readonly approvalId?: ApprovalRequestId | undefined;
        readonly externalCallId: string;
        readonly toolName: ToolName;
      }
    | undefined;
}

export interface AwaitingVerificationContinuation {
  readonly type: "AWAITING_VERIFICATION";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly verificationPlanId: VerificationPlanId;
  readonly finalDecision: AgentFinalCandidateDecision;
}

export interface WaitingVerificationRepairContinuation {
  readonly type: "WAITING_VERIFICATION_REPAIR";
  readonly runId: RunId;
  readonly failedPlanId: VerificationPlanId;
  readonly sourceStepId: StepId;
  readonly failedCheckIds: readonly VerificationCheckId[];
  readonly evidenceIds: readonly VerificationEvidenceId[];
  readonly repairCycle: number;
}

export type RetryErrorCode = "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT";

interface WaitingRetryContinuationBase {
  readonly type: "WAITING_RETRY";
  readonly runId: RunId;
  readonly failedStepId: StepId;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: import("@caelush/protocol").TimestampMs;
  readonly errorCode: RetryErrorCode;
}

export type WaitingRetryContinuation =
  | (WaitingRetryContinuationBase & {
      readonly mode: "START";
      readonly pendingDecision?: never;
      readonly receivedResults?: never;
    })
  | (WaitingRetryContinuationBase & {
      readonly mode: "TOOL_RESULTS";
      readonly pendingDecision: AgentToolCallsDecision;
      readonly receivedResults: readonly LLMToolResultMessage[];
    });

export type RunContinuationCheckpoint =
  | WaitingToolResultsContinuation
  | AwaitingVerificationContinuation
  | WaitingVerificationRepairContinuation
  | WaitingRetryContinuation;
