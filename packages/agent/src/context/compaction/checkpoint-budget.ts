import type { ContextCompactionPlan } from "./context-compaction-contracts.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { ModelDescriptor } from "@caelush/ai";
import {
  createStructuredCheckpoint,
  createStructuredCheckpointV2,
  type StructuredCheckpoint,
  type StructuredCheckpointV2,
} from "../checkpoint/structured-checkpoint.js";
import {
  createUtf8HeuristicTokenEstimator,
  type ContextTokenEstimatorPort,
} from "../token/context-token-estimator.js";

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

export class ContextCheckpointExceedsBudgetError extends RangeError {
  constructor() {
    super("Mandatory checkpoint data exceeds the configured checkpoint budget.");
    this.name = "ContextCheckpointExceedsBudgetError";
  }
}

/**
 * Enforce the final prompt-cost ceiling after semantic output and trusted host facts are merged.
 * Only replaceable semantic memory is reduced; constraints, blockers, live facts, and references
 * remain byte-for-byte intact. Older list entries are dropped first so the newest state survives.
 */
export function fitStructuredCheckpointToBudget(input: {
  readonly checkpoint: StructuredCheckpoint;
  readonly maxTokens: number;
  readonly model: ModelDescriptor;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
}): StructuredCheckpoint;
export function fitStructuredCheckpointToBudget(input: {
  readonly checkpoint: StructuredCheckpointV2;
  readonly maxTokens: number;
  readonly model: ModelDescriptor;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
}): StructuredCheckpointV2;
export function fitStructuredCheckpointToBudget(input: {
  readonly checkpoint: StructuredCheckpoint | StructuredCheckpointV2;
  readonly maxTokens: number;
  readonly model: ModelDescriptor;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
}): StructuredCheckpoint | StructuredCheckpointV2 {
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive safe integer.");
  }
  const estimator = input.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
  const freeze = (value: typeof input.checkpoint) =>
    value.version === 1 ? createStructuredCheckpoint(value) : createStructuredCheckpointV2(value);
  let current = freeze(input.checkpoint);
  const estimate = (value: typeof current) =>
    estimator.estimateText(JSON.stringify(value), input.model);
  if (estimate(current) <= input.maxTokens) return current;

  const compactable = [
    "completedWork",
    "importantDiscoveries",
    "keyDecisions",
    "inProgress",
    "criticalReferences",
  ] as const;
  for (const field of compactable) {
    while (current[field].length > 0 && estimate(current) > input.maxTokens) {
      current = freeze({ ...current, [field]: current[field].slice(1) });
    }
    if (estimate(current) <= input.maxTokens) return current;
  }

  // `nextIntent` is a hint, so shorten it at a UTF-8 boundary only after replaceable history has
  // been removed. Host-owned facts and protected constraints are never rewritten to hit a number.
  const intent = current.nextIntent;
  let low = 0;
  let high = intent.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateIntent = middle === 0 ? "" : `${intent.slice(0, middle)}…`;
    const candidate = freeze({ ...current, nextIntent: candidateIntent });
    if (estimate(candidate) <= input.maxTokens) {
      best = candidateIntent;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  current = freeze({ ...current, nextIntent: best });
  if (estimate(current) > input.maxTokens) throw new ContextCheckpointExceedsBudgetError();
  return current;
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
      const maxTokens = Math.min(
        desiredMax,
        MAX_CHECKPOINT_TOKENS,
        input.policy.deepCompaction?.checkpointMaxTokens ?? MAX_CHECKPOINT_TOKENS,
        selectedLimit,
      );
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
