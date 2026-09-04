export type ContextUsagePressureState = "NORMAL" | "PROACTIVE" | "EMERGENCY";

export interface ContextUsageBreakdown {
  readonly pinned: number;
  readonly checkpoint: number;
  readonly recentTail: number;
  readonly project: number;
  readonly files: number;
  readonly toolObservations: number;
  readonly memory: number;
}

export interface ContextUsageProjectionInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSource?: import("./model-context-profile.js").ModelContextProfileSource;
  readonly contextWindowTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly estimatedInputTokens: number;
  readonly pressureState: ContextUsagePressureState;
  readonly compactionCount: number;
  readonly lastCompactionAt?: number;
  readonly breakdown: ContextUsageBreakdown;
  readonly updatedAt: number;
  readonly lastBuildStatus?: "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";
}

export interface ContextUsageProjection extends Omit<
  ContextUsageProjectionInput,
  "profileSource" | "lastBuildStatus"
> {
  readonly profileSource: import("./model-context-profile.js").ModelContextProfileSource;
  readonly lastBuildStatus: "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";
  readonly usedRatio: number;
  readonly remainingTokens: number;
}

function safeNonNegative(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function createContextUsageProjection(
  input: ContextUsageProjectionInput,
): ContextUsageProjection {
  if (input.runId.trim() === "" || input.providerId.trim() === "" || input.modelId.trim() === "") {
    throw new RangeError("Context usage identity must not be empty");
  }
  safeNonNegative("contextWindowTokens", input.contextWindowTokens);
  safeNonNegative("effectiveInputLimitTokens", input.effectiveInputLimitTokens);
  safeNonNegative("estimatedInputTokens", input.estimatedInputTokens);
  safeNonNegative("compactionCount", input.compactionCount);
  safeNonNegative("updatedAt", input.updatedAt);
  if (input.effectiveInputLimitTokens === 0) {
    throw new RangeError("effectiveInputLimitTokens must be positive");
  }
  const usedRatio = Math.max(
    0,
    Math.min(1, input.estimatedInputTokens / input.effectiveInputLimitTokens),
  );
  return Object.freeze({
    ...input,
    profileSource: input.profileSource ?? "FALLBACK",
    lastBuildStatus: input.lastBuildStatus ?? "SUCCESS",
    estimatedInputTokens: input.estimatedInputTokens,
    usedRatio,
    remainingTokens: Math.max(0, input.effectiveInputLimitTokens - input.estimatedInputTokens),
    breakdown: Object.freeze({ ...input.breakdown }),
  });
}
