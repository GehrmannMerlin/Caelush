import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type {
  AgentError,
  AgentRun,
  ApprovalRequestId,
  AgentState,
  StepId,
  ToolInvocationId,
  ToolName,
  VerificationPlanId,
} from "@caelush/protocol";
import type { AgentToolRequest } from "./agent-decision.js";
import type { RetryErrorCode } from "./agent-continuation.js";

export type RunControllerResult =
  | { readonly status: "PENDING"; readonly run: AgentRun; readonly state?: AgentState }
  | { readonly status: "RUNNING"; readonly run: AgentRun; readonly state: AgentState }
  | {
      readonly status: "WAITING_TOOL_RESULTS";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly sourceStepId: StepId;
      readonly toolRequests: readonly AgentToolRequest[];
    }
  | {
      readonly status: "WAITING_APPROVAL";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly sourceStepId: StepId;
      readonly invocationId: ToolInvocationId;
      readonly approvalId?: ApprovalRequestId;
      readonly externalCallId: string;
      readonly toolName: ToolName;
    }
  | {
      readonly status: "WAITING_RETRY";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly nextAttemptAt: AgentRun["createdAt"];
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly errorCode: RetryErrorCode;
    }
  | {
      readonly status: "AWAITING_VERIFICATION";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly sourceStepId: StepId;
      readonly verificationPlanId: VerificationPlanId;
      readonly candidateText: string;
    }
  | {
      readonly status: "FAILED";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly error: AgentError;
    }
  | { readonly status: "MAX_STEPS_REACHED"; readonly run: AgentRun; readonly state: AgentState }
  | {
      readonly status: "CANCELLATION_PENDING";
      readonly run: AgentRun;
      readonly state?: AgentState;
    }
  | {
      readonly status: "TIMEOUT_PENDING";
      readonly run: AgentRun;
      readonly state?: AgentState;
    }
  | {
      readonly status: "BUDGET_EXCEEDED_PENDING";
      readonly run: AgentRun;
      readonly state?: AgentState;
    }
  | { readonly status: "TERMINAL"; readonly run: AgentRun; readonly state?: AgentState };

export type RunControllerToolResults = readonly LLMToolResultMessage[];
