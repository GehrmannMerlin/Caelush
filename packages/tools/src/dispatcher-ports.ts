import type { ToolDefinition, ToolInvocation, ToolName } from "@caelush/protocol";
import type { DurableToolAgentEvent, ToolDefinitionMetadata } from "./dispatcher-types.js";

export type ToolExecutionGateDecision =
  { readonly kind: "ALLOW" } | { readonly kind: "DENY" } | { readonly kind: "REQUIRE_APPROVAL" };

export interface ToolExecutionGateInput {
  readonly invocation: ToolInvocation;
  readonly toolName: ToolName;
  readonly definition: ToolDefinitionMetadata | ToolDefinition;
}

export interface ToolExecutionGatePort {
  decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision>;
}

export interface ToolCommittedEventNotifier {
  notifyCommitted(events: readonly DurableToolAgentEvent[]): void;
}
