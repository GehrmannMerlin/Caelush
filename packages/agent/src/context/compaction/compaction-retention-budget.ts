import type { CompactionTargetStatus } from "./context-checkpoint-v3.js";

export interface CompactionRetentionBudget {
  readonly fixedTokens: number;
  readonly recentTokens: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
  readonly targetInputTokens: number;
  readonly availableInputTokens: number;
  readonly targetStatus: CompactionTargetStatus;
}

export interface CompactionRetentionBudgetInput {
  readonly fixedTokens: number;
  readonly recentTokens: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
  readonly availableInputTokens: number;
}

/** Resolve the exact post-compaction input target from the content that must remain. */
export function resolveCompactionRetentionBudget(
  input: CompactionRetentionBudgetInput,
): CompactionRetentionBudget {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }
  if (input.availableInputTokens < 1) {
    throw new RangeError("availableInputTokens must be positive.");
  }
  const requested =
    input.fixedTokens + input.recentTokens + input.checkpointMaxTokens + input.boundaryTokens;
  if (!Number.isSafeInteger(requested)) {
    throw new RangeError("Compaction retention target exceeds safe integer range.");
  }
  const targetStatus: CompactionTargetStatus =
    requested <= input.availableInputTokens ? "DEEP" : "FLOOR_LIMITED";
  return Object.freeze({
    ...input,
    targetInputTokens: Math.min(requested, input.availableInputTokens),
    targetStatus,
  });
}

/** Check the full materialized input against both the hard limit and desired retention target. */
export function acceptCompactionCandidate(input: {
  readonly inputTokens: number;
  readonly budget: CompactionRetentionBudget;
}): boolean {
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) return false;
  return (
    input.inputTokens <= input.budget.targetInputTokens &&
    input.inputTokens <= input.budget.availableInputTokens
  );
}
