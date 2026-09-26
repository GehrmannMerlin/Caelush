import type { ModelRef } from "@caelush/ai";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { ContextFingerprint } from "../contracts/context-fingerprint.js";
import type { ContextPressureState } from "../policy/context-policy.js";

export type ContextUsageBuildStatus = "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";

export interface ContextUsageSourceBreakdown {
  readonly sourceId: string;
  readonly tokens: number;
  readonly itemCount: number;
}

export interface ContextUsageSnapshot {
  readonly runId: RunId;
  readonly modelRef: ModelRef;
  readonly contextWindowTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly estimatedInputTokens: number;
  readonly remainingTokens: number;
  readonly pressureState: ContextPressureState;
  readonly compactionCount: number;
  readonly lastCompactionAt?: TimestampMs;
  readonly breakdown: readonly ContextUsageSourceBreakdown[];
  readonly lastBuildStatus: ContextUsageBuildStatus;
  readonly contextFingerprint?: ContextFingerprint;
  readonly updatedAt: TimestampMs;
}

export interface ContextUsageStorePort {
  upsert(state: ContextUsageSnapshot): Promise<void>;
  getByRun(runId: RunId): Promise<ContextUsageSnapshot | undefined>;
}
