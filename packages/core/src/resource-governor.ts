import type { RunResourcePolicy } from "@caelush/protocol";

import type { ResourceCorrectionStage } from "./resource-progress-projection.js";

export type { ResourceCorrectionStage } from "./resource-progress-projection.js";

/**
 * One synthetic model-facing result for a call the Run never dispatched.
 *
 * ```text
 * kind               always UNAVAILABLE_TOOL: nothing ran, so nothing is being reported as a result
 * externalCallId     the model call this answers, so the batch stays cardinality-preserving
 * toolName           the Tool the model asked for, echoed back unexecuted
 * content            the safe guidance the model receives in its place
 * isError            true — an unexecuted call is a recoverable failure, never a success
 * ```
 *
 * It is deliberately **not** a durable shape. No invocation, no observation and no raw artifact pointer
 * can appear here, because a replan creates none: Phase 4F replaced the legacy `ToolBatchItemResult`
 * with this Core-local shape precisely so a governance decision cannot borrow the vocabulary of the
 * ledger.
 */
export interface SyntheticToolResult {
  readonly kind: "UNAVAILABLE_TOOL";
  readonly externalCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: true;
}

/**
 * The rung of the corrective ladder a nudge belongs to.
 *
 * It is carried on the decision so the guidance the model receives, and the ledger entry that records
 * its delivery, name the same intervention. A bare "reminder sent" with no identity is what made the
 * previous delivery unverifiable. The union itself is declared once, with the rest of the correction
 * vocabulary.
 */
export type ResourceDecision =
  | { readonly kind: "ALLOW" }
  | {
      readonly kind: "ALLOW_WITH_NUDGE";
      readonly guidance: string;
      readonly stage?: ResourceCorrectionStage | undefined;
    }
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

/**
 * The accounting one Tool batch is admitted against.
 *
 * ```text
 * cumulativeAgentTurns        every model turn this Run has spent — the hard-budget unit
 * cumulativeToolOperations    every physical Tool operation this Run has performed — the hard-budget unit
 * turnsInLease                turns since this lease epoch started — the lease unit
 * toolsInLease                operations since this lease epoch started — the lease unit
 * ```
 *
 * The two pairs answer different questions and must never be substituted for one another. A hard
 * budget is about the whole Run: "you have used 900 of your 1000 operations". A lease is about the
 * current stretch of work: "this stretch has done 24 turns, renew the governance checkpoint". Comparing
 * a lease threshold against a cumulative total means every batch after the threshold renews, which is
 * how one incident accumulated a lease epoch of 52 while never actually exhausting anything.
 */
export interface ResourceToolBatchEvaluationInput {
  readonly cumulativeAgentTurns: number;
  readonly cumulativeToolOperations: number;
  readonly turnsInLease: number;
  readonly toolsInLease: number;
  readonly requestedToolCalls: number;
  /**
   * `WAITING_RESOURCE` is only ever produced by the V1 discipline from repeated-failure evidence: it is
   * not a clock and not a turn count, and it means "this specific mistake has already been re-planned
   * the configured number of times".
   */
  readonly progressLevel: "HEALTHY" | "NUDGE" | "FORCED_REPLAN" | "WAITING_RESOURCE";
  /** The Run-lifetime re-plan total. A statistic, and under V2 never a pause threshold. */
  readonly replanCount: number;
  readonly currentLeaseEpoch?: number;
  /** Specific guidance for a semantic reminder; absent for the generic nudge. */
  readonly guidance?: string | undefined;
  /** Which corrective rung the guidance belongs to. */
  readonly correctionStage?: ResourceCorrectionStage | undefined;
}

const REPLAN_GUIDANCE =
  "Recent actions are producing little new information. Avoid repeating equivalent tool calls. Reuse existing evidence and choose a different approach.";

/**
 * The Tool-batch resource authority.
 *
 * It answers one question — may this batch run, and under what accounting — from four independent
 * facts: the batch size, the hard budgets, the lease, and the corrective advice. It never decides
 * whether a *Tool* is allowed to do something (Security owns that) and it never runs anything.
 */
export class ResourceGovernor {
  constructor(private readonly policy: RunResourcePolicy) {}

  /** Whether this Run corrects autonomously rather than pausing on repeated mistakes. */
  private get autonomous(): boolean {
    return this.policy.correctionVersion === "AUTONOMOUS_CORRECTION_V2";
  }

  evaluateToolBatch(input: ResourceToolBatchEvaluationInput): ResourceDecision {
    assertNonNegativeInteger(input.cumulativeAgentTurns, "cumulativeAgentTurns");
    assertNonNegativeInteger(input.cumulativeToolOperations, "cumulativeToolOperations");
    assertNonNegativeInteger(input.turnsInLease, "turnsInLease");
    assertNonNegativeInteger(input.toolsInLease, "toolsInLease");
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
      input.cumulativeToolOperations > maxToolCalls - input.requestedToolCalls
    ) {
      return {
        kind: "HARD_STOP",
        dimension: "TOOL_CALLS",
        accounted: input.cumulativeToolOperations,
        limit: maxToolCalls,
      };
    }
    if (input.progressLevel === "WAITING_RESOURCE") {
      // Only V1 evidence produces this level, and only V1 answers it with a wait. A V2 Run that reached
      // here would mean its projection produced a V1-only level, which is refused rather than
      // silently converted into a pause nobody configured.
      if (this.autonomous) {
        return {
          kind: "ALLOW_WITH_NUDGE",
          guidance: input.guidance ?? REPLAN_GUIDANCE,
          ...(input.correctionStage === undefined ? {} : { stage: input.correctionStage }),
        };
      }
      return { kind: "WAIT_FOR_RESOURCE_DECISION", reason: "NO_PROGRESS" };
    }
    if (input.progressLevel === "FORCED_REPLAN") {
      if (!this.autonomous) {
        if (input.replanCount >= this.policy.progress.replansBeforePause) {
          return { kind: "WAIT_FOR_RESOURCE_DECISION", reason: "NO_PROGRESS" };
        }
        return {
          kind: "REPLAN",
          requestedToolCalls: input.requestedToolCalls,
          reason: "NO_PROGRESS",
        };
      }
      // V2: the batch in front of us is admitted on its own merits. Repeated failure changes what the
      // model is told, never whether the corrected call may run.
      return {
        kind: "ALLOW_WITH_NUDGE",
        guidance: input.guidance ?? REPLAN_GUIDANCE,
        ...(input.correctionStage === undefined ? {} : { stage: input.correctionStage }),
      };
    }
    const leaseExhausted =
      input.turnsInLease >= this.policy.operationalLease.maxAgentTurns ||
      input.toolsInLease + input.requestedToolCalls > this.policy.operationalLease.maxToolOperations;
    // A lease is renewed at a healthy boundary only. Renewing because of a mistake would reset the
    // accounting that is supposed to make the mistake visible; the mistake is the reason *not* to move
    // the checkpoint.
    if (leaseExhausted && input.progressLevel === "HEALTHY") {
      return {
        kind: "RENEW_AND_ALLOW",
        nextLeaseEpoch: (input.currentLeaseEpoch ?? 1) + 1,
      };
    }
    if (input.progressLevel === "NUDGE") {
      return {
        kind: "ALLOW_WITH_NUDGE",
        guidance: input.guidance ?? REPLAN_GUIDANCE,
        ...(input.correctionStage === undefined ? {} : { stage: input.correctionStage }),
      };
    }
    return { kind: "ALLOW" };
  }

  static replanResults(
    calls: readonly { readonly externalCallId: string; readonly toolName: string }[],
  ): readonly SyntheticToolResult[] {
    return calls.map((call) => ({
      kind: "UNAVAILABLE_TOOL" as const,
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
