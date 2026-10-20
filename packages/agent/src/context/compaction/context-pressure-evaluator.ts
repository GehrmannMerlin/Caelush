import type { ContextPressureState } from "../policy/context-policy.js";

export type ContextPressureTrigger =
  | "NONE"
  | "PROACTIVE_PRESSURE"
  | "EMERGENCY_PRESSURE"
  | "SELECTION_PRESSURE"
  | "HISTORY_SELECTION_PRESSURE"
  | "FORCED_PROVIDER_OVERFLOW";

export interface ContextPressureInput {
  /** Complete materialized message input estimate, before request overhead. */
  readonly estimatedInputTokens: number;
  readonly selectedPlanningTokens: number;
  readonly mandatoryTokens: number;
  readonly historySelectionPressure: boolean;
  readonly effectiveInputLimitTokens: number;
  readonly proactiveCompactionTokens: number;
  readonly emergencyCompactionTokens: number;
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
  readonly mode: "NORMAL" | "FORCED_RECOVERY";
  readonly hasCompressibleHistory: boolean;
  /**
   * Elective-compaction pacing.
   *
   * Absent means "this Run keeps the legacy rule": the `PROACTIVE` label changes the reported state
   * but never starts a summarisation on its own. Present means the frozen policy opted in, and the
   * schedule decides whether this turn may act.
   */
  readonly proactive?:
    | {
        readonly enabled: boolean;
        readonly armed: boolean;
        readonly cooldownTurnsRemaining: number;
        readonly emergency: boolean;
      }
    | undefined;
}

export interface ContextPressureEvaluation {
  readonly state: ContextPressureState;
  readonly trigger: ContextPressureTrigger;
  readonly pressureRatio: number;
  readonly shouldCompact: boolean;
  readonly targetPostCompactionTokens: number;
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
}

export interface ContextPressureEvaluator {
  evaluate(input: ContextPressureInput): ContextPressureEvaluation;
}

const HYSTERESIS_RATIO = 0.8;

export function createContextPressureEvaluator(): ContextPressureEvaluator {
  return Object.freeze({
    evaluate(input: ContextPressureInput): ContextPressureEvaluation {
      assertPressureInput(input);
      const state = classifyState(input.estimatedInputTokens, input);
      const trigger = classifyTrigger(state, input);
      // Both bands are elective-compaction territory: `PROACTIVE` acts early, `EMERGENCY` acts now
      // without waiting out the cooldown, because the window is already failing.
      const proactiveDue =
        state !== "NORMAL" &&
        input.proactive !== undefined &&
        input.proactive.enabled &&
        (input.proactive.emergency ||
          (input.proactive.armed && input.proactive.cooldownTurnsRemaining === 0));
      const shouldCompact =
        input.mode === "FORCED_RECOVERY" ||
        input.estimatedInputTokens >= input.effectiveInputLimitTokens ||
        input.historySelectionPressure ||
        proactiveDue;
      return Object.freeze({
        state,
        trigger,
        pressureRatio: input.estimatedInputTokens / input.effectiveInputLimitTokens,
        shouldCompact: shouldCompact && input.hasCompressibleHistory,
        targetPostCompactionTokens: Math.floor(input.effectiveInputLimitTokens * HYSTERESIS_RATIO),
        targetRecentTailTokens: input.targetRecentTailTokens,
        minRecentTailTokens: input.minRecentTailTokens,
      });
    },
  });
}

function classifyState(
  estimatedInputTokens: number,
  input: ContextPressureInput,
): ContextPressureState {
  if (estimatedInputTokens >= input.emergencyCompactionTokens) return "EMERGENCY";
  if (estimatedInputTokens >= input.proactiveCompactionTokens) return "PROACTIVE";
  return "NORMAL";
}

function classifyTrigger(
  state: ContextPressureState,
  input: ContextPressureInput,
): ContextPressureTrigger {
  if (input.mode === "FORCED_RECOVERY") return "FORCED_PROVIDER_OVERFLOW";
  if (input.mandatoryTokens > input.effectiveInputLimitTokens) return "SELECTION_PRESSURE";
  if (input.historySelectionPressure) return "HISTORY_SELECTION_PRESSURE";
  if (input.estimatedInputTokens >= input.effectiveInputLimitTokens) {
    return state === "EMERGENCY" ? "EMERGENCY_PRESSURE" : "PROACTIVE_PRESSURE";
  }
  if (state === "EMERGENCY") return "EMERGENCY_PRESSURE";
  if (state === "PROACTIVE") return "PROACTIVE_PRESSURE";
  return "NONE";
}

function assertPressureInput(input: ContextPressureInput): void {
  assertNonNegativeSafeInteger(input.estimatedInputTokens, "estimatedInputTokens");
  assertNonNegativeSafeInteger(input.selectedPlanningTokens, "selectedPlanningTokens");
  assertNonNegativeSafeInteger(input.mandatoryTokens, "mandatoryTokens");
  if (input.mandatoryTokens > input.selectedPlanningTokens) {
    throw new RangeError("Mandatory planning tokens must not exceed selected planning tokens.");
  }
  assertPositiveSafeInteger(input.effectiveInputLimitTokens, "effectiveInputLimitTokens");
  assertNonNegativeSafeInteger(input.proactiveCompactionTokens, "proactiveCompactionTokens");
  assertNonNegativeSafeInteger(input.emergencyCompactionTokens, "emergencyCompactionTokens");
  assertNonNegativeSafeInteger(input.targetRecentTailTokens, "targetRecentTailTokens");
  assertNonNegativeSafeInteger(input.minRecentTailTokens, "minRecentTailTokens");
  if (input.proactiveCompactionTokens >= input.emergencyCompactionTokens) {
    throw new RangeError("Proactive pressure must be below emergency pressure.");
  }
  if (input.emergencyCompactionTokens > input.effectiveInputLimitTokens) {
    throw new RangeError("Emergency pressure must not exceed the effective input limit.");
  }
  if (input.minRecentTailTokens > input.targetRecentTailTokens) {
    throw new RangeError("Minimum recent tail must not exceed the target recent tail.");
  }
  if (input.mode !== "NORMAL" && input.mode !== "FORCED_RECOVERY") {
    throw new RangeError("Context pressure mode is invalid.");
  }
  if (typeof input.hasCompressibleHistory !== "boolean") {
    throw new TypeError("hasCompressibleHistory must be boolean.");
  }
  if (typeof input.historySelectionPressure !== "boolean") {
    throw new TypeError("historySelectionPressure must be boolean.");
  }
  if (input.proactive !== undefined) {
    if (typeof input.proactive.enabled !== "boolean") {
      throw new TypeError("proactive.enabled must be boolean.");
    }
    if (typeof input.proactive.armed !== "boolean") {
      throw new TypeError("proactive.armed must be boolean.");
    }
    if (typeof input.proactive.emergency !== "boolean") {
      throw new TypeError("proactive.emergency must be boolean.");
    }
    assertNonNegativeSafeInteger(
      input.proactive.cooldownTurnsRemaining,
      "proactive.cooldownTurnsRemaining",
    );
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(label + " must be a non-negative safe integer.");
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(label + " must be a positive safe integer.");
  }
}
