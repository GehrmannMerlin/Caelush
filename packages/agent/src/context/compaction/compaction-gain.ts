import type { ContextCheckpointBudget } from "./checkpoint-budget.js";
import type { ContextCompactionPlan } from "./context-compaction-contracts.js";

const MINIMUM_GAIN_RATIO = 0.15;

export interface ContextCompactionGain {
  readonly selectedTokens: number;
  readonly estimatedCheckpointTokens: number;
  readonly estimatedFreedTokens: number;
  readonly gainRatio: number;
}

export interface ContextCompactionGainEvaluator {
  evaluate(input: {
    readonly plan: ContextCompactionPlan;
    readonly checkpointBudget: ContextCheckpointBudget;
  }): ContextCompactionGain;
}

export function createContextCompactionGainEvaluator(): ContextCompactionGainEvaluator {
  return Object.freeze({
    evaluate(input: {
      readonly plan: ContextCompactionPlan;
      readonly checkpointBudget: ContextCheckpointBudget;
    }): ContextCompactionGain {
      assertPositiveSafeInteger(input.plan.selectedTokens, "selectedTokens");
      assertPositiveSafeInteger(input.checkpointBudget.targetTokens, "targetTokens");
      assertPositiveSafeInteger(input.checkpointBudget.maxTokens, "maxTokens");
      if (
        input.checkpointBudget.targetTokens > input.checkpointBudget.maxTokens ||
        input.checkpointBudget.maxTokens >= input.plan.selectedTokens
      ) {
        throw new RangeError("Checkpoint budget must fit below the selected compaction source.");
      }
      const estimatedFreedTokens =
        input.plan.selectedTokens - input.checkpointBudget.maxTokens;
      return Object.freeze({
        selectedTokens: input.plan.selectedTokens,
        estimatedCheckpointTokens: input.checkpointBudget.maxTokens,
        estimatedFreedTokens,
        gainRatio: estimatedFreedTokens / input.plan.selectedTokens,
      });
    },
  });
}

/** Package-internal gate used by ContextEngine; deliberately absent from public exports. */
export function isMeaningfulContextCompactionGain(gain: ContextCompactionGain): boolean {
  return gain.estimatedFreedTokens > 0 && gain.gainRatio >= MINIMUM_GAIN_RATIO;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
