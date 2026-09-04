export type ContextUsagePressureState = "NORMAL" | "PROACTIVE" | "EMERGENCY";

export interface ContextUsageBreakdown {
  readonly pinned: number;
  readonly checkpoint: number;
  readonly recentTail: number;
  readonly project: number;
  readonly files: number;
  readonly toolObservations: number;
  readonly memory: number;
  readonly systemTokens: number;
  readonly goalTokens: number;
  readonly currentUserTokens: number;
  readonly relevantFileTokens: number;
  readonly currentTurnTokens: number;
  readonly mandatoryTokens: number;
}

export type ContextUsageBreakdownInput = Omit<
  ContextUsageBreakdown,
  | "systemTokens"
  | "goalTokens"
  | "currentUserTokens"
  | "relevantFileTokens"
  | "currentTurnTokens"
  | "mandatoryTokens"
> &
  Partial<
    Pick<
      ContextUsageBreakdown,
      | "systemTokens"
      | "goalTokens"
      | "currentUserTokens"
      | "relevantFileTokens"
      | "currentTurnTokens"
      | "mandatoryTokens"
    >
  >;

export interface ContextUsageProjectionInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSource?: import("./model-context-profile.js").ModelContextProfileSource;
  readonly contextWindowTokens: number;
  readonly rawContextWindowTokens?: number;
  readonly effectiveInputLimitTokens: number;
  readonly estimatedInputTokens: number;
  readonly pressureState: ContextUsagePressureState;
  readonly compactionCount: number;
  readonly lastCompactionAt?: number;
  readonly breakdown: ContextUsageBreakdownInput;
  readonly updatedAt: number;
  readonly lastBuildAt?: number;
  readonly lastRecoveryStages?: readonly string[];
  readonly lastBuildStatus?: "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";
}

export interface ContextUsageProjection extends Omit<
  ContextUsageProjectionInput,
  "profileSource" | "lastBuildStatus" | "breakdown" | "rawContextWindowTokens"
> {
  readonly profileSource: import("./model-context-profile.js").ModelContextProfileSource;
  readonly lastBuildStatus: "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";
  readonly rawContextWindowTokens: number;
  readonly breakdown: ContextUsageBreakdown;
  readonly lastBuildAt: number;
  readonly lastRecoveryStages: readonly string[];
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
  if (input.rawContextWindowTokens !== undefined) {
    safeNonNegative("rawContextWindowTokens", input.rawContextWindowTokens);
  }
  const rawContextWindowTokens = input.rawContextWindowTokens ?? input.contextWindowTokens;
  if (input.effectiveInputLimitTokens > rawContextWindowTokens) {
    throw new RangeError("effectiveInputLimitTokens must not exceed rawContextWindowTokens");
  }
  if (input.lastBuildAt !== undefined) safeNonNegative("lastBuildAt", input.lastBuildAt);
  if (input.effectiveInputLimitTokens === 0) {
    throw new RangeError("effectiveInputLimitTokens must be positive");
  }
  const breakdown: ContextUsageBreakdown = {
    ...input.breakdown,
    systemTokens: input.breakdown.systemTokens ?? input.breakdown.project,
    goalTokens: input.breakdown.goalTokens ?? 0,
    currentUserTokens: input.breakdown.currentUserTokens ?? 0,
    relevantFileTokens: input.breakdown.relevantFileTokens ?? input.breakdown.files,
    currentTurnTokens: input.breakdown.currentTurnTokens ?? input.breakdown.recentTail,
    mandatoryTokens: input.breakdown.mandatoryTokens ?? 0,
  };
  for (const [name, value] of Object.entries(breakdown)) {
    safeNonNegative(`breakdown.${name}`, value);
  }
  const usedRatio = Math.max(
    0,
    Math.min(1, input.estimatedInputTokens / input.effectiveInputLimitTokens),
  );
  return Object.freeze({
    ...input,
    rawContextWindowTokens,
    profileSource: input.profileSource ?? "FALLBACK",
    lastBuildStatus: input.lastBuildStatus ?? "SUCCESS",
    estimatedInputTokens: input.estimatedInputTokens,
    usedRatio,
    remainingTokens: Math.max(0, input.effectiveInputLimitTokens - input.estimatedInputTokens),
    breakdown: Object.freeze(breakdown),
    lastBuildAt: input.lastBuildAt ?? input.updatedAt,
    lastRecoveryStages: Object.freeze([...(input.lastRecoveryStages ?? [])]),
  });
}
