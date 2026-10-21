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
  /**
   * Whether a `PROACTIVE` pressure reading may actually start a compaction.
   *
   * Defaults to enabled: the whole point of having a 75% band is to act inside it. A host that needs
   * the historical behaviour (label only, compact at the limit) sets this to false.
   */
  readonly proactiveCompactionEnabled?: boolean;
  /** Fall back below this ratio before another ordinary attempt is allowed. */
  readonly proactiveCompactionRearmRatio?: number;
  /** Minimum new model turns between ordinary attempts. */
  readonly proactiveCompactionCooldownTurns?: number;
  /** Run-frozen V2 working-set thresholds; absent retains the historical Context policy. */
  readonly workingSet?: ContextWorkingSetPolicy;
}

export interface ContextWorkingSetPolicy {
  readonly targetTokens: number;
  readonly triggerRatio: number;
  readonly postCompactionRatio: number;
  readonly allowCurrentTurnPrefix: boolean;
  readonly cooldownTurns: number;
}

export interface ContextPolicyInput {
  readonly model: ModelDescriptor;
  readonly tools?: readonly AIToolSpec[];
  readonly requestOverhead?: ContextRequestOverhead;
  readonly options?: ContextPolicyOptions;
}

export type ContextPressureState = "NORMAL" | "PROACTIVE" | "EMERGENCY";

export interface AdaptiveContextBudgetInput {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly configuredOutputCeiling?: number;
  readonly requestOverheadTokens: number;
}

export interface AdaptiveContextBudget {
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly preferredOutputCeiling: number;
  readonly effectiveInputLimitTokens: number;
}

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
  readonly historySelectionPressure: boolean;
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
  readonly targetPostCompactionTokens?: number;
  readonly allowCurrentTurnPrefix?: boolean;
  readonly workingSet?: ContextWorkingSetPolicy;
  readonly observationPolicy: ToolObservationPolicySnapshot;
  readonly conversationCapTokens: number;
  readonly sourceLimits: Readonly<Record<string, number>>;
  readonly elasticPoolTokens: number;
  /** Frozen pacing of elective compaction for this policy. */
  readonly proactiveCompaction: {
    readonly enabled: boolean;
    readonly rearmRatio: number;
    readonly cooldownTurns: number;
  };
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

/** Resolve the per-Run reserves and effective message-input budget once. */
export function resolveAdaptiveContextBudget(
  input: AdaptiveContextBudgetInput,
): AdaptiveContextBudget {
  assertPositiveSafeInteger(input.contextWindowTokens, "contextWindowTokens");
  assertPositiveSafeInteger(input.maxOutputTokens, "maxOutputTokens");
  assertNonNegativeSafeInteger(input.requestOverheadTokens, "requestOverheadTokens");
  if (input.configuredOutputCeiling !== undefined) {
    assertPositiveSafeInteger(input.configuredOutputCeiling, "configuredOutputCeiling");
  }

  const preferredOutputCeiling = Math.min(
    input.configuredOutputCeiling ?? input.maxOutputTokens,
    input.maxOutputTokens,
  );
  const outputReserveTokens = Math.min(
    preferredOutputCeiling,
    16_384,
    Math.max(1, Math.floor(input.contextWindowTokens * 0.08)),
  );
  const safetyReserveTokens = Math.min(
    4_096,
    Math.max(1, Math.floor(input.contextWindowTokens * 0.01)),
  );
  const effectiveInputLimitTokens =
    input.contextWindowTokens -
    outputReserveTokens -
    safetyReserveTokens -
    input.requestOverheadTokens;
  if (effectiveInputLimitTokens <= 0) {
    throw new RangeError("Context reserves and request overhead leave no positive input budget.");
  }

  return Object.freeze({
    outputReserveTokens,
    safetyReserveTokens,
    preferredOutputCeiling,
    effectiveInputLimitTokens,
  });
}

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
  const baseMinRecentTailTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    minRecentTailRatio,
    options.minRecentTailTokensCap ?? DEFAULTS.minRecentTailTokensCap,
  );
  const workingSet = options.workingSet;
  if (workingSet !== undefined) assertWorkingSet(workingSet, effectiveInputLimitTokens);
  const targetPostCompactionTokens =
    workingSet === undefined
      ? Math.floor(effectiveInputLimitTokens * 0.8)
      : Math.max(1, Math.floor(workingSet.targetTokens * workingSet.postCompactionRatio));
  const boundedTargetRecentTailTokens = Math.min(
    targetRecentTailTokens,
    targetPostCompactionTokens,
  );
  const minRecentTailTokens = Math.min(baseMinRecentTailTokens, boundedTargetRecentTailTokens);
  const emergencyCompactionTokens = Math.floor(
    effectiveInputLimitTokens * emergencyCompactionRatio,
  );
  const proactiveCompactionTokens =
    workingSet === undefined
      ? Math.floor(effectiveInputLimitTokens * proactiveCompactionRatio)
      : Math.max(1, Math.floor(workingSet.targetTokens * workingSet.triggerRatio));
  if (proactiveCompactionTokens >= emergencyCompactionTokens) {
    throw new RangeError("Proactive compaction threshold must remain below emergency pressure.");
  }
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
    minRecentTailTokens > boundedTargetRecentTailTokens ||
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
    proactiveCompactionTokens,
    emergencyCompactionTokens,
    targetRecentTailTokens: boundedTargetRecentTailTokens,
    minRecentTailTokens,
    targetPostCompactionTokens,
    allowCurrentTurnPrefix: workingSet?.allowCurrentTurnPrefix ?? false,
    ...(workingSet === undefined ? {} : { workingSet: Object.freeze({ ...workingSet }) }),
    observationPolicy: Object.freeze({ maxSingleObservationTokens, maxObservationBatchTokens }),
    conversationCapTokens,
    sourceLimits,
    elasticPoolTokens: Math.max(0, effectiveInputLimitTokens - boundedTargetRecentTailTokens),
    proactiveCompaction: Object.freeze({
      enabled: options.proactiveCompactionEnabled ?? true,
      rearmRatio: options.proactiveCompactionRearmRatio ?? 0.65,
      cooldownTurns: workingSet?.cooldownTurns ?? options.proactiveCompactionCooldownTurns ?? 4,
    }),
  });
}

function assertWorkingSet(
  workingSet: ContextWorkingSetPolicy,
  effectiveInputLimitTokens: number,
): void {
  assertPositiveSafeInteger(workingSet.targetTokens, "workingSet.targetTokens");
  if (workingSet.targetTokens > effectiveInputLimitTokens) {
    throw new RangeError("Working-set targetTokens must not exceed the effective input budget.");
  }
  assertRatio(workingSet.triggerRatio, "workingSet.triggerRatio");
  assertRatio(workingSet.postCompactionRatio, "workingSet.postCompactionRatio");
  assertNonNegativeSafeInteger(workingSet.cooldownTurns, "workingSet.cooldownTurns");
  if (typeof workingSet.allowCurrentTurnPrefix !== "boolean") {
    throw new TypeError("workingSet.allowCurrentTurnPrefix must be boolean.");
  }
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

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new RangeError(`${label} must be a positive safe integer.`);
}

export type { ToolObservationPolicySnapshot };
