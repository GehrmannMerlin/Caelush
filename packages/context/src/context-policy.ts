import type { ModelContextProfile } from "./model-context-profile.js";

export interface ContextPolicyOptions {
  readonly outputReserveTokens?: number;
  readonly safetyReserveTokens?: number;
  readonly proactiveCompactionRatio?: number;
  readonly emergencyCompactionRatio?: number;
  readonly postCompactionTargetRatio?: number;
  readonly targetRecentTailTokensCap?: number;
  readonly targetRecentTailRatio?: number;
  readonly minRecentTailTokensCap?: number;
  readonly minRecentTailRatio?: number;
  readonly maxSingleObservationTokensCap?: number;
  readonly maxSingleObservationRatio?: number;
  readonly maxObservationBatchTokensCap?: number;
  readonly maxObservationBatchRatio?: number;
  readonly maxConversationTokens?: number;
  readonly maxRelevantFileTokens?: number;
  readonly maxMemoryContextTokens?: number;
}

export interface ContextPolicy {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly effectiveInputLimit: number;
  readonly proactiveCompactionRatio: number;
  readonly emergencyCompactionRatio: number;
  readonly postCompactionTargetRatio: number;
  readonly proactiveCompactionTokens: number;
  readonly emergencyCompactionTokens: number;
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
  readonly conversationCapTokens: number;
  readonly relevantFileCapTokens: number;
  readonly maxMemoryContextTokens: number;
  readonly elasticPoolTokens: number;
}

const DEFAULT_SAFETY_RESERVE = 512;
const DEFAULT_TARGET_TAIL_CAP = 20_000;
const DEFAULT_TARGET_TAIL_RATIO = 0.35;
const DEFAULT_MIN_TAIL_CAP = 8000;
const DEFAULT_MIN_TAIL_RATIO = 0.15;
const DEFAULT_OBSERVATION_CAP = 8192;
const DEFAULT_OBSERVATION_RATIO = 0.1;
const DEFAULT_OBSERVATION_BATCH_CAP = 16_384;
const DEFAULT_OBSERVATION_BATCH_RATIO = 0.22;

function safeInteger(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function ratio(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function optionalCap(name: string, value: number | undefined, minimum = 0): void {
  if (value !== undefined) safeInteger(name, value, minimum);
}

export function createContextPolicy(
  profile: ModelContextProfile,
  options: ContextPolicyOptions = {},
): ContextPolicy {
  const outputReserveTokens = options.outputReserveTokens ?? profile.recommendedOutputReserveTokens;
  const safetyReserveTokens = options.safetyReserveTokens ?? DEFAULT_SAFETY_RESERVE;
  safeInteger("outputReserveTokens", outputReserveTokens, 0);
  safeInteger("safetyReserveTokens", safetyReserveTokens, 0);
  const reservedTokens = outputReserveTokens + safetyReserveTokens;
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens >= profile.contextWindowTokens) {
    throw new RangeError("outputReserveTokens and safetyReserveTokens leave no input budget");
  }
  const proactiveCompactionRatio = options.proactiveCompactionRatio ?? 0.75;
  const emergencyCompactionRatio = options.emergencyCompactionRatio ?? 0.9;
  const postCompactionTargetRatio = options.postCompactionTargetRatio ?? 0.5;
  ratio("proactiveCompactionRatio", proactiveCompactionRatio);
  ratio("emergencyCompactionRatio", emergencyCompactionRatio);
  ratio("postCompactionTargetRatio", postCompactionTargetRatio);
  if (proactiveCompactionRatio >= emergencyCompactionRatio) {
    throw new RangeError(
      "pressure ratios require proactiveCompactionRatio < emergencyCompactionRatio",
    );
  }
  const targetRecentTailRatio = options.targetRecentTailRatio ?? DEFAULT_TARGET_TAIL_RATIO;
  const minRecentTailRatio = options.minRecentTailRatio ?? DEFAULT_MIN_TAIL_RATIO;
  const maxSingleObservationRatio = options.maxSingleObservationRatio ?? DEFAULT_OBSERVATION_RATIO;
  const maxObservationBatchRatio =
    options.maxObservationBatchRatio ?? DEFAULT_OBSERVATION_BATCH_RATIO;
  ratio("targetRecentTailRatio", targetRecentTailRatio);
  ratio("minRecentTailRatio", minRecentTailRatio);
  ratio("maxSingleObservationRatio", maxSingleObservationRatio);
  ratio("maxObservationBatchRatio", maxObservationBatchRatio);
  optionalCap("targetRecentTailTokensCap", options.targetRecentTailTokensCap);
  optionalCap("minRecentTailTokensCap", options.minRecentTailTokensCap);
  optionalCap("maxSingleObservationTokensCap", options.maxSingleObservationTokensCap, 1);
  optionalCap("maxObservationBatchTokensCap", options.maxObservationBatchTokensCap, 1);
  const effectiveInputLimit =
    profile.contextWindowTokens - outputReserveTokens - safetyReserveTokens;
  const targetRecentTailTokens = Math.min(
    options.targetRecentTailTokensCap ?? DEFAULT_TARGET_TAIL_CAP,
    Math.floor(effectiveInputLimit * targetRecentTailRatio),
  );
  const minRecentTailTokens = Math.min(
    options.minRecentTailTokensCap ?? DEFAULT_MIN_TAIL_CAP,
    Math.floor(effectiveInputLimit * minRecentTailRatio),
  );
  const maxSingleObservationTokens = Math.min(
    options.maxSingleObservationTokensCap ?? DEFAULT_OBSERVATION_CAP,
    Math.floor(effectiveInputLimit * maxSingleObservationRatio),
  );
  const maxObservationBatchTokens = Math.min(
    options.maxObservationBatchTokensCap ?? DEFAULT_OBSERVATION_BATCH_CAP,
    Math.floor(effectiveInputLimit * maxObservationBatchRatio),
  );
  if (
    minRecentTailTokens > targetRecentTailTokens ||
    maxSingleObservationTokens < 1 ||
    maxObservationBatchTokens < 1
  ) {
    throw new RangeError("context policy cannot allocate a bounded tail and observation budget");
  }
  const conversationCapTokens = options.maxConversationTokens ?? 12_000;
  const relevantFileCapTokens = options.maxRelevantFileTokens ?? 12_000;
  const maxMemoryContextTokens =
    options.maxMemoryContextTokens ?? Math.max(1, Math.floor(effectiveInputLimit * 0.1));
  safeInteger("maxConversationTokens", conversationCapTokens);
  safeInteger("maxRelevantFileTokens", relevantFileCapTokens);
  safeInteger("maxMemoryContextTokens", maxMemoryContextTokens, 1);
  return {
    contextWindowTokens: profile.contextWindowTokens,
    outputReserveTokens,
    safetyReserveTokens,
    effectiveInputLimit,
    proactiveCompactionRatio,
    emergencyCompactionRatio,
    postCompactionTargetRatio,
    proactiveCompactionTokens: Math.floor(effectiveInputLimit * proactiveCompactionRatio),
    emergencyCompactionTokens: Math.floor(effectiveInputLimit * emergencyCompactionRatio),
    targetRecentTailTokens,
    minRecentTailTokens,
    maxSingleObservationTokens,
    maxObservationBatchTokens,
    conversationCapTokens,
    relevantFileCapTokens,
    maxMemoryContextTokens,
    elasticPoolTokens: Math.max(0, effectiveInputLimit - targetRecentTailTokens),
  };
}

export function shouldProactivelyCompact(
  estimatedInputTokens: number,
  policy: ContextPolicy,
): boolean {
  return estimatedInputTokens >= policy.proactiveCompactionTokens;
}

export function shouldEmergencyCompact(
  estimatedInputTokens: number,
  policy: ContextPolicy,
): boolean {
  return estimatedInputTokens >= policy.emergencyCompactionTokens;
}
