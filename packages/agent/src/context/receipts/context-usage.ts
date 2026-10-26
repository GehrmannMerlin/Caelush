import type { ModelRef } from "@caelush/ai";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { ContextFingerprint } from "../contracts/context-fingerprint.js";
import type { ContextPressureState } from "../policy/context-policy.js";
import type { ContextPromptSurfaceReceipt } from "./context-build-receipt.js";
import type { TurnBudgetDecision } from "../policy/request-headroom.js";
import type { CompactionRetentionDiagnostics } from "../compaction/compaction-retention-budget.js";

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
  /** Tokens added by the provider request envelope and Tool schemas. */
  readonly requestOverheadTokens?: number;
  /** Estimated model input including request overhead. */
  readonly fullRequestInputEstimateTokens?: number;
  /** Full request estimate divided by the model's complete context window. */
  readonly fullWindowUsedRatio?: number;
  readonly remainingTokens: number;
  readonly pressureState: ContextPressureState;
  readonly compactionCount: number;
  readonly lastCompactionAt?: TimestampMs;
  /** Compatibility projection of the bounded recovery stages used by the existing API. */
  readonly lastRecoveryStages?: readonly string[];
  readonly breakdown: readonly ContextUsageSourceBreakdown[];
  readonly lastBuildStatus: ContextUsageBuildStatus;
  readonly contextFingerprint?: ContextFingerprint;
  readonly promptSurface?: ContextPromptSurfaceReceipt;
  /**
   * The turn's frozen `HEADROOM_V1` decision.
   *
   * Persisted with the usage snapshot so "why did this turn reorganize history" is answerable after
   * a restart, from the same row the ring and the inspector already read.
   */
  readonly turnBudget?: TurnBudgetDecision;
  /** Last durably committed elastic retention decision, if available. */
  readonly lastCompactionRetention?: CompactionRetentionDiagnostics;
  readonly updatedAt: TimestampMs;
}

export interface ContextUsageStorePort {
  upsert(state: ContextUsageSnapshot): Promise<void>;
  getByRun(runId: RunId): Promise<ContextUsageSnapshot | undefined>;
}
