import type {
  ApprovalRequest,
  RunId,
  ToolDefinition,
  ToolInvocation,
  ToolInvocationId,
  ToolName,
} from "@caelush/protocol";
import type { DurableToolAgentEvent, ToolDefinitionMetadata } from "./dispatcher-types.js";
import type { ToolSecurityContext } from "./security-context.js";

export type ToolExecutionGateDecision =
  | { readonly kind: "ALLOW"; readonly reasonCode?: string; readonly safeReason?: string }
  | { readonly kind: "DENY"; readonly reasonCode?: string; readonly safeReason?: string }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly reasonCode?: string;
      readonly safeReason?: string;
    };

export interface ToolExecutionGateInput {
  readonly invocation: ToolInvocation;
  readonly toolName: ToolName;
  readonly definition: ToolDefinitionMetadata | ToolDefinition;
  readonly securityContext: ToolSecurityContext;
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
