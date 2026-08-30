import type {
  JsonObject,
  ObservationId,
  RunId,
  SessionId,
  StepId,
  ToolDefinition,
  ToolInvocationId,
  ToolName,
} from "@caelush/protocol";
import type { ToolExecutionEnvironment } from "./execution-environment.js";
import type { ToolSecurityContext } from "./security-context.js";

export interface ToolBatchItem {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

export interface ToolBatchRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly items: readonly ToolBatchItem[];
}

export type ToolBatchItemResultKind =
  "TOOL_RESULT" | "UNAVAILABLE_TOOL" | "SKIPPED_AFTER_UNCERTAIN_EXECUTION";

export interface ToolBatchItemResult {
  readonly kind: ToolBatchItemResultKind;
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly content: string;
  readonly isError: boolean;
  readonly invocationId?: ToolInvocationId;
  readonly observationId?: ObservationId;
}

export interface ToolBatchCompletedOutcome {
  readonly kind: "COMPLETED";
  readonly results: readonly ToolBatchItemResult[];
}

export interface ToolBatchWaitingApprovalOutcome {
  readonly kind: "WAITING_APPROVAL";
  readonly completedResults: readonly ToolBatchItemResult[];
  readonly waiting: {
    readonly index: number;
    readonly invocationId: ToolInvocationId;
    readonly approvalId?: import("@caelush/protocol").ApprovalRequestId;
    readonly externalCallId: string;
    readonly toolName: ToolName;
  };
}

export type ToolBatchOutcome = ToolBatchCompletedOutcome | ToolBatchWaitingApprovalOutcome;

export interface ToolBatchCoordinatorPort {
  modelDefinitions(): readonly ToolDefinition[];
  execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
  recover(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
}
