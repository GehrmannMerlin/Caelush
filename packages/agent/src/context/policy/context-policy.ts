import type { AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import {
  assertContextRequestOverhead,
  createContextRequestOverheadEstimator,
  type ContextRequestOverhead,
} from "../token/request-overhead-estimator.js";
import type { ContextItem, ContextItemId } from "../item/context-item.js";

export interface ContextPolicyOptions {
  readonly outputReserveTokens?: number;
  readonly safetyReserveTokens?: number;
  readonly proactiveCompactionRatio?: number;
  readonly emergencyCompactionRatio?: number;
  readonly targetRecentTailTokensCap?: number;
  readonly targetRecentTailRatio?: number;
  readonly minRecentTailTokensCap?: number;
  readonly minRecentTailRatio?: number;
  readonly maxSingleObservationTokensCap?: number;
  readonly maxSingleObservationRatio?: number;
  readonly maxObservationBatchTokensCap?: number;
  readonly maxObservationBatchRatio?: number;
  readonly conversationCapTokens?: number;
  readonly sourceLimits?: Readonly<Record<string, number>>;
}

export interface ContextPolicyInput {
  readonly model: ModelDescriptor;
  readonly tools?: readonly AIToolSpec[];
  readonly requestOverhead?: ContextRequestOverhead;
  readonly options?: ContextPolicyOptions;
}

export type ContextPressureState = "NORMAL" | "PROACTIVE" | "EMERGENCY";

export interface ContextBudgetSnapshot {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly requestOverheadTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly mandatoryTokens: number;
  readonly selectedTokens: number;
  readonly remainingTokens: number;
}

export type ContextItemDisposition = "SELECTED" | "DROPPED" | "DEFERRED" | "COMPACTED";
export type ContextItemDecisionReason =
  | "MANDATORY"
  | "PINNED"
  | "RECENT"
  | "PRIORITY"
  | "SOURCE_LIMIT"
  | "TOTAL_BUDGET"
  | "RETRIEVABLE_DEFERRED"
  | "STALE"
  | "SENSITIVE"
  | "COMPACTED"
  | "OPEN_PROTOCOL_UNIT";

export interface ContextItemDecision {
  readonly itemId: ContextItemId;
  readonly disposition: ContextItemDisposition;
  readonly reason: ContextItemDecisionReason;
  readonly tokenEstimate: number;
}

export interface ContextPlan {
  readonly selectedItems: readonly ContextItem[];
  readonly decisions: readonly ContextItemDecision[];
  readonly budget: ContextBudgetSnapshot;
  readonly pressure: ContextPressureState;
  readonly requiresCompaction: boolean;
}

export interface ContextPolicy {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly requestOverhead: ContextRequestOverhead;
  readonly effectiveInputLimitTokens: number;
  readonly proactiveCompactionRatio: number;
  readonly emergencyCompactionRatio: number;
  readonly proactiveCompactionTokens: number;
  readonly emergencyCompactionTokens: number;
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
  readonly observationPolicy: ToolObservationPolicySnapshot;
  readonly conversationCapTokens: number;
  readonly sourceLimits: Readonly<Record<string, number>>;
  readonly elasticPoolTokens: number;
}

const DEFAULTS = {
  safetyReserveTokens: 512,
  proactiveCompactionRatio: 0.75,
  emergencyCompactionRatio: 0.9,
  targetRecentTailTokensCap: 20_000,
  targetRecentTailRatio: 0.35,
  minRecentTailTokensCap: 8_000,
  minRecentTailRatio: 0.15,
  maxSingleObservationTokensCap: 8_192,
  maxSingleObservationRatio: 0.1,
  maxObservationBatchTokensCap: 16_384,
  maxObservationBatchRatio: 0.22,
  conversationCapTokens: 12_000,
} as const;

export function createContextPolicy(input: ContextPolicyInput): ContextPolicy {
  const options = input.options ?? {};
  const resolvedRequestOverhead =
    input.requestOverhead ??
    createContextRequestOverheadEstimator().estimate({
      model: input.model,
      tools: input.tools ?? [],
    });
  assertContextRequestOverhead(resolvedRequestOverhead);
  const requestOverhead = Object.freeze({ ...resolvedRequestOverhead });
  const contextWindowTokens = input.model.limits.contextWindowTokens;
  const maxOutputTokens = input.model.limits.maxOutputTokens;
  const outputReserveTokens = options.outputReserveTokens ?? maxOutputTokens;
  const safetyReserveTokens = options.safetyReserveTokens ?? DEFAULTS.safetyReserveTokens;
  assertNonNegativeSafeInteger(outputReserveTokens, "outputReserveTokens");
  assertNonNegativeSafeInteger(safetyReserveTokens, "safetyReserveTokens");
  const effectiveInputLimitTokens =
    contextWindowTokens - outputReserveTokens - safetyReserveTokens - requestOverhead.totalTokens;
  if (outputReserveTokens >= contextWindowTokens || effectiveInputLimitTokens <= 0) {
    throw new RangeError("Context reserves and request overhead leave no positive input budget.");
  }

  const proactiveCompactionRatio =
    options.proactiveCompactionRatio ?? DEFAULTS.proactiveCompactionRatio;
  const emergencyCompactionRatio =
    options.emergencyCompactionRatio ?? DEFAULTS.emergencyCompactionRatio;
  assertRatio(proactiveCompactionRatio, "proactiveCompactionRatio");
  assertRatio(emergencyCompactionRatio, "emergencyCompactionRatio");
  if (proactiveCompactionRatio >= emergencyCompactionRatio)
    throw new RangeError("Proactive pressure must be below emergency pressure.");

  const targetRecentTailRatio = options.targetRecentTailRatio ?? DEFAULTS.targetRecentTailRatio;
  const minRecentTailRatio = options.minRecentTailRatio ?? DEFAULTS.minRecentTailRatio;
  const maxSingleObservationRatio =
    options.maxSingleObservationRatio ?? DEFAULTS.maxSingleObservationRatio;
  const maxObservationBatchRatio =
    options.maxObservationBatchRatio ?? DEFAULTS.maxObservationBatchRatio;
  assertRatio(targetRecentTailRatio, "targetRecentTailRatio");
  assertRatio(minRecentTailRatio, "minRecentTailRatio");
  assertRatio(maxSingleObservationRatio, "maxSingleObservationRatio");
  assertRatio(maxObservationBatchRatio, "maxObservationBatchRatio");

  const targetRecentTailTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    targetRecentTailRatio,
    options.targetRecentTailTokensCap ?? DEFAULTS.targetRecentTailTokensCap,
  );
  const minRecentTailTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    minRecentTailRatio,
    options.minRecentTailTokensCap ?? DEFAULTS.minRecentTailTokensCap,
  );
  const maxSingleObservationTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    maxSingleObservationRatio,
    options.maxSingleObservationTokensCap ?? DEFAULTS.maxSingleObservationTokensCap,
  );
  const maxObservationBatchTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    maxObservationBatchRatio,
    options.maxObservationBatchTokensCap ?? DEFAULTS.maxObservationBatchTokensCap,
  );
  if (
    minRecentTailTokens > targetRecentTailTokens ||
    maxSingleObservationTokens < 1 ||
    maxObservationBatchTokens < 1
  ) {
    throw new RangeError("Context policy cannot allocate a bounded tail and observation budget.");
  }
  const conversationCapTokens = options.conversationCapTokens ?? DEFAULTS.conversationCapTokens;
  assertNonNegativeSafeInteger(conversationCapTokens, "conversationCapTokens");
  const sourceLimits = freezeSourceLimits(options.sourceLimits);
  return Object.freeze({
    contextWindowTokens,
    maxOutputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    requestOverhead,
    effectiveInputLimitTokens,
    proactiveCompactionRatio,
    emergencyCompactionRatio,
    proactiveCompactionTokens: Math.floor(effectiveInputLimitTokens * proactiveCompactionRatio),
    emergencyCompactionTokens: Math.floor(effectiveInputLimitTokens * emergencyCompactionRatio),
    targetRecentTailTokens,
    minRecentTailTokens,
    observationPolicy: Object.freeze({ maxSingleObservationTokens, maxObservationBatchTokens }),
    conversationCapTokens,
    sourceLimits,
    elasticPoolTokens: Math.max(0, effectiveInputLimitTokens - targetRecentTailTokens),
  });
}

export function classifyContextPressure(
  estimatedInputTokens: number,
  policy: ContextPolicy,
): ContextPressureState {
  if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) {
    throw new RangeError("estimatedInputTokens must be a non-negative safe integer.");
  }
  if (estimatedInputTokens >= policy.emergencyCompactionTokens) return "EMERGENCY";
  if (estimatedInputTokens >= policy.proactiveCompactionTokens) return "PROACTIVE";
  return "NORMAL";
}

function boundedRatioCap(limit: number, ratio: number, cap: number): number {
  assertNonNegativeSafeInteger(cap, "context policy cap");
  return Math.min(cap, Math.floor(limit * ratio));
}

function freezeSourceLimits(
  value: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const limits: Record<string, number> = {};
  for (const [source, limit] of Object.entries(value ?? {})) {
    if (source.trim().length === 0)
      throw new RangeError("Context source limit id must not be empty.");
    assertNonNegativeSafeInteger(limit, `sourceLimits.${source}`);
    limits[source] = limit;
  }
  return Object.freeze(limits);
}

function assertRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1)
    throw new RangeError(`${label} must be between 0 and 1.`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RangeError(`${label} must be a non-negative safe integer.`);
}

export type { ToolObservationPolicySnapshot };
