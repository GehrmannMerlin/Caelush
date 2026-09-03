import type { RunResourcePolicy } from "@caelush/protocol";
import type { ToolBatchItemResult } from "@caelush/tools";

export type ResourceDecision =
  | { readonly kind: "ALLOW" }
  | { readonly kind: "ALLOW_WITH_NUDGE"; readonly guidance: string }
  | { readonly kind: "RENEW_AND_ALLOW"; readonly nextLeaseEpoch: number }
  | {
      readonly kind: "REPLAN";
      readonly requestedToolCalls: number;
      readonly reason: "BATCH_TOO_LARGE" | "NO_PROGRESS";
    }
  | { readonly kind: "WAIT_FOR_RESOURCE_DECISION"; readonly reason: "NO_PROGRESS" }
  | {
      readonly kind: "HARD_STOP";
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

export interface ResourceToolBatchEvaluationInput {
  readonly agentTurnsConsumed: number;
  readonly toolOperationsConsumed: number;
  readonly requestedToolCalls: number;
  readonly progressLevel: "HEALTHY" | "NUDGE" | "FORCED_REPLAN";
  readonly replanCount: number;
  readonly currentLeaseEpoch?: number;
}

const REPLAN_GUIDANCE =
  "Recent actions are producing little new information. Avoid repeating equivalent tool calls. Reuse existing evidence and choose a different approach.";

export class ResourceGovernor {
  constructor(private readonly policy: RunResourcePolicy) {}

  evaluateToolBatch(input: ResourceToolBatchEvaluationInput): ResourceDecision {
    assertNonNegativeInteger(input.agentTurnsConsumed, "agentTurnsConsumed");
    assertNonNegativeInteger(input.toolOperationsConsumed, "toolOperationsConsumed");
    assertNonNegativeInteger(input.requestedToolCalls, "requestedToolCalls");
    assertNonNegativeInteger(input.replanCount, "replanCount");
    if (input.requestedToolCalls > this.policy.batch.maxToolCallsPerTurn) {
      return {
        kind: "REPLAN",
        requestedToolCalls: input.requestedToolCalls,
        reason: "BATCH_TOO_LARGE",
      };
    }
    const maxToolCalls = this.policy.hardLimits.maxToolCalls;
    if (
      maxToolCalls !== undefined &&
      input.toolOperationsConsumed > maxToolCalls - input.requestedToolCalls
    ) {
      return {
        kind: "HARD_STOP",
        dimension: "TOOL_CALLS",
        accounted: input.toolOperationsConsumed,
        limit: maxToolCalls,
      };
    }
    if (
      input.progressLevel === "FORCED_REPLAN" &&
      input.replanCount >= this.policy.progress.replansBeforePause
    ) {
      return { kind: "WAIT_FOR_RESOURCE_DECISION", reason: "NO_PROGRESS" };
    }
    if (input.progressLevel === "FORCED_REPLAN") {
      return {
        kind: "REPLAN",
        requestedToolCalls: input.requestedToolCalls,
        reason: "NO_PROGRESS",
      };
    }
    const checkpointReached =
      input.agentTurnsConsumed >= this.policy.operationalLease.maxAgentTurns ||
      input.toolOperationsConsumed + input.requestedToolCalls >
        this.policy.operationalLease.maxToolOperations;
    if (checkpointReached && input.progressLevel === "HEALTHY") {
      return {
        kind: "RENEW_AND_ALLOW",
        nextLeaseEpoch: (input.currentLeaseEpoch ?? 1) + 1,
      };
    }
    if (input.progressLevel === "NUDGE") {
      return { kind: "ALLOW_WITH_NUDGE", guidance: REPLAN_GUIDANCE };
    }
    return { kind: "ALLOW" };
  }

  static replanResults(
    calls: readonly { readonly externalCallId: string; readonly toolName: string }[],
  ): readonly ToolBatchItemResult[] {
    return calls.map((call) => ({
      kind: "UNAVAILABLE_TOOL",
      externalCallId: call.externalCallId,
      toolName: call.toolName,
      content:
        "No tool from this requested batch was executed. The recent execution path has produced insufficient new progress. Re-evaluate the current task state and choose a different approach. Reuse prior observations and avoid repeating equivalent operations.",
      isError: true,
    }));
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be safe.`);
}
