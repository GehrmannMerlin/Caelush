import type {
  ApprovalRequest,
  RunId,
  ToolDefinition,
  ToolInvocation,
  ToolInvocationId,
  ToolName,
  JsonObject,
} from "@caelush/protocol";
import type { DurableToolAgentEvent, ToolDefinitionMetadata } from "./dispatcher-types.js";
import type { ToolSecurityContext } from "./security-context.js";

export type ToolExecutionGateDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    };

export interface ToolExecutionGateInput {
  readonly invocation: ToolInvocation;
  readonly toolName: ToolName;
  readonly definition: ToolDefinitionMetadata | ToolDefinition;
  readonly securityContext: ToolSecurityContext;
  readonly runtimeKind?: string;
  readonly securityFacts?: import("./security-facts.js").ToolSecurityFacts;
}

export interface ToolExecutionGatePort {
  decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision>;
}

export interface ToolCommittedEventNotifier {
  notifyCommitted(events: readonly DurableToolAgentEvent[]): void;
}

export interface ToolApprovalStorePort {
  getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null>;
  getApprovalKeyByInvocation?(toolInvocationId: ToolInvocationId): Promise<string | null>;
  findApplicableRunGrant(input: {
    readonly runId: RunId;
    readonly approvalKey: string;
  }): Promise<ApprovalRequest | null>;
}

export type ToolBudgetAdmission =
  | { readonly kind: "ALLOWED" }
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

/** Structural boundary; the concrete ledger adapter remains outside Tools. */
export interface ToolBudgetAdmissionPort {
  admit(input: {
    readonly runId: RunId;
    readonly requested: number;
    readonly invocationId?: ToolInvocationId;
  }): Promise<ToolBudgetAdmission>;
  /**
   * Optional whole-segment admission. The caller must provide only calls that
   * have already passed the adapter's non-execution preflight. Returning an
   * exceeded result prevents the dispatcher from creating any invocation or
   * starting any handler in that segment.
   */
  admitBatch?(input: {
    readonly runId: RunId;
    readonly requested: number;
  }): Promise<ToolBudgetAdmission>;
  start?(input: { readonly runId: RunId; readonly invocationId: ToolInvocationId }): Promise<void>;
  settle?(input: { readonly runId: RunId; readonly invocationId: ToolInvocationId }): Promise<void>;
}
