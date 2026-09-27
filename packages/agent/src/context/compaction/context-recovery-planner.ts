import type { ContextPrepareMode } from "../contracts/context-engine.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { ContextPressureEvaluation } from "./context-pressure-evaluator.js";

export type ContextRecoveryStage = "NORMAL" | "FORCED";

export type ContextRecoveryAction =
  | "DEFER_LOW_RETRIEVABLE"
  | "REDUCE_OPTIONAL_SOURCES"
  | "COMPACT_HISTORY"
  | "TIGHTEN_RECENT_TAIL"
  | "EXHAUSTED";

export interface ContextRecoveryPlan {
  readonly stage: ContextRecoveryStage;
  readonly actions: readonly ContextRecoveryAction[];
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
}

export interface ContextRecoveryPlanner {
  plan(input: {
    readonly mode: ContextPrepareMode;
    readonly pressure: ContextPressureEvaluation;
    readonly policy: ContextPolicy;
    readonly hasCompressibleHistory: boolean;
  }): ContextRecoveryPlan;
}

const FORCED_ACTIONS = Object.freeze([
  "DEFER_LOW_RETRIEVABLE",
  "REDUCE_OPTIONAL_SOURCES",
  "COMPACT_HISTORY",
  "TIGHTEN_RECENT_TAIL",
  "EXHAUSTED",
] as const satisfies readonly ContextRecoveryAction[]);

/** The Agent-owned bounded recovery decision table. */
export function createContextRecoveryPlanner(): ContextRecoveryPlanner {
  return Object.freeze({
    plan(input: Parameters<ContextRecoveryPlanner["plan"]>[0]): ContextRecoveryPlan {
      const actions: readonly ContextRecoveryAction[] =
        input.pressure.shouldCompact && input.hasCompressibleHistory ? ["COMPACT_HISTORY"] : [];
      if (input.mode === "FORCED_RECOVERY") {
        return Object.freeze({
          stage: "FORCED",
          actions: FORCED_ACTIONS,
          targetRecentTailTokens: forcedTarget(input.policy),
          minRecentTailTokens: forcedMinimum(input.policy),
        });
      }
      return Object.freeze({
        stage: "NORMAL",
        actions,
        targetRecentTailTokens: input.policy.targetRecentTailTokens,
        minRecentTailTokens: input.policy.minRecentTailTokens,
      });
    },
  });
}

export function withRecoveryTailPolicy(
  policy: ContextPolicy,
  recovery: ContextRecoveryPlan,
): ContextPolicy {
  if (
    recovery.targetRecentTailTokens === policy.targetRecentTailTokens &&
    recovery.minRecentTailTokens === policy.minRecentTailTokens
  ) {
    return policy;
  }
  return Object.freeze({
    ...policy,
    targetRecentTailTokens: recovery.targetRecentTailTokens,
    minRecentTailTokens: recovery.minRecentTailTokens,
    elasticPoolTokens: Math.max(
      0,
      policy.effectiveInputLimitTokens - recovery.targetRecentTailTokens,
    ),
  });
}

function forcedTarget(policy: ContextPolicy): number {
  return Math.min(
    policy.targetRecentTailTokens,
    Math.max(1, Math.min(4_096, Math.floor(policy.effectiveInputLimitTokens * 0.12))),
  );
}

function forcedMinimum(policy: ContextPolicy): number {
  const target = forcedTarget(policy);
  return Math.min(
    target,
    Math.max(1, Math.min(1_024, Math.floor(policy.effectiveInputLimitTokens * 0.05))),
  );
}
