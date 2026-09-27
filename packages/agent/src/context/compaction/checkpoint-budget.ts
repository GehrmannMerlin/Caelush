import type { ContextCompactionPlan } from "./context-compaction-contracts.js";
import type { ContextPolicy } from "../policy/context-policy.js";

const TARGET_RATIO = 0.05;
const MAX_RATIO = 0.08;
const MAX_CHECKPOINT_TOKENS = 8_192;

export interface ContextCheckpointBudget {
  readonly targetTokens: number;
  readonly maxTokens: number;
}

export interface ContextCheckpointBudgetResolver {
  resolve(input: {
    readonly policy: ContextPolicy;
    readonly plan: ContextCompactionPlan;
  }): ContextCheckpointBudget;
}

export class ContextCheckpointBudgetUnavailableError extends RangeError {
  readonly code = "CHECKPOINT_BUDGET_UNAVAILABLE" as const;

  constructor() {
    super("No positive bounded checkpoint budget is available for this compaction plan.");
    this.name = "ContextCheckpointBudgetUnavailableError";
  }
}

export function createContextCheckpointBudgetResolver(): ContextCheckpointBudgetResolver {
  return Object.freeze({
    resolve(input: {
      readonly policy: ContextPolicy;
      readonly plan: ContextCompactionPlan;
    }): ContextCheckpointBudget {
      assertPositiveSafeInteger(
        input.policy.effectiveInputLimitTokens,
        "effectiveInputLimitTokens",
      );
      assertPositiveSafeInteger(input.plan.selectedTokens, "selectedTokens");
      if (input.plan.selectedTokens <= 1) throw new ContextCheckpointBudgetUnavailableError();

      const selectedLimit = input.plan.selectedTokens - 1;
      const desiredMax = Math.max(
        1,
        Math.floor(input.policy.effectiveInputLimitTokens * MAX_RATIO),
      );
      const maxTokens = Math.min(desiredMax, MAX_CHECKPOINT_TOKENS, selectedLimit);
      if (maxTokens < 1) throw new ContextCheckpointBudgetUnavailableError();
      const targetTokens = Math.min(
        maxTokens,
        Math.max(1, Math.floor(input.policy.effectiveInputLimitTokens * TARGET_RATIO)),
      );
      if (targetTokens < 1) throw new ContextCheckpointBudgetUnavailableError();
      return Object.freeze({ targetTokens, maxTokens });
    },
  });
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
