import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type { ToolObservationPolicySnapshot } from "@caelush/agent";
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
  /**
   * The Tool observation policy the requesting turn was prepared under.
   *
   * The canonical type is Agent-owned; this is the durable spelling of it. Optional on purpose:
   * a checkpoint written before the field existed still decodes, and every new write persists it.
   */
  readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
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

export interface WaitingResourceContinuation {
  readonly type: "WAITING_RESOURCE";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly reason: "NO_PROGRESS";
  readonly replanCount: number;
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
      readonly sourceStepId?: undefined;
    })
  | (WaitingRetryContinuationBase & {
      readonly mode: "TOOL_RESULTS";
      readonly pendingDecision: AgentToolCallsDecision;
      readonly receivedResults: readonly LLMToolResultMessage[];
      /**
       * The durable Step that requested the tools this retry is resuming with.
       *
       * `failedStepId` names the attempt that failed; it is a different Step. Only the tool
       * request's own Step is the resume provenance, and it must survive an arbitrary number of
       * retry attempts — so it is persisted here on the first retry and carried forward by every
       * later one.
       *
       * Optional because the field arrived after the shape did: a durable checkpoint written by
       * an earlier build does not contain it, and the decoder distinguishes "absent" from
       * "present but undefined". Recovery either determines it from the durable conversation or
       * fails closed; it never guesses.
       */
      readonly sourceStepId?: StepId | undefined;
      /** The Tool observation policy the retry resumes its Tool projection under. */
      readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
    });

export type RunContinuationCheckpoint =
  | WaitingToolResultsContinuation
  | AwaitingVerificationContinuation
  | WaitingVerificationRepairContinuation
  | WaitingResourceContinuation
  | WaitingRetryContinuation;
