import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

export type ContextRuntimeState = {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSource:
    "CONFIGURATION" | "KNOWN_METADATA" | "LEGACY_LIMITS" | "OVERRIDE" | "FALLBACK";
  readonly contextWindowTokens: number;
  readonly rawContextWindowTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly estimatedInputTokens: number;
  readonly remainingTokens: number;
  readonly pressureState: "NORMAL" | "PROACTIVE" | "EMERGENCY";
  readonly compactionCount: number;
  readonly lastCompactionAt?: number;
  readonly lastBuildAt: number;
  readonly breakdown: {
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
  };
  readonly lastRecoveryStages: readonly string[];
  readonly lastBuildStatus: "SUCCESS" | "FAILED" | "CONTEXT_EXHAUSTED";
  readonly updatedAt: number;
};

type ContextRuntimeBreakdown = ContextRuntimeState["breakdown"];

export interface ContextRuntimeStateRepository {
  upsert(state: ContextRuntimeState): Promise<void>;
  getByRun(runId: string): Promise<ContextRuntimeState | undefined>;
}

function decode(row: Record<string, unknown>): ContextRuntimeState {
  return {
    runId: String(row.run_id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    profileSource: String(row.profile_source) as ContextRuntimeState["profileSource"],
    contextWindowTokens: Number(row.context_window_tokens),
    rawContextWindowTokens:
      row.raw_context_window_tokens === undefined || row.raw_context_window_tokens === null
        ? Number(row.context_window_tokens)
        : Number(row.raw_context_window_tokens),
    effectiveInputLimitTokens: Number(row.effective_input_limit_tokens),
    estimatedInputTokens: Number(row.estimated_input_tokens),
    remainingTokens: Number(row.remaining_tokens),
    pressureState: String(row.pressure_state) as ContextRuntimeState["pressureState"],
    compactionCount: Number(row.compaction_count),
    ...(row.last_compaction_at_ms === null
      ? {}
      : { lastCompactionAt: Number(row.last_compaction_at_ms) }),
    lastBuildAt:
      row.last_build_at_ms === undefined || row.last_build_at_ms === null
        ? Number(row.updated_at_ms)
        : Number(row.last_build_at_ms),
    breakdown: normalizeBreakdown(
      JSON.parse(String(row.breakdown_json)) as Record<string, unknown>,
    ),
    lastRecoveryStages:
      row.last_recovery_stages_json === undefined || row.last_recovery_stages_json === null
        ? []
        : (JSON.parse(String(row.last_recovery_stages_json)) as string[]),
    lastBuildStatus: String(row.last_build_status) as ContextRuntimeState["lastBuildStatus"],
    updatedAt: Number(row.updated_at_ms),
  };
}

function normalizeBreakdown(value: Record<string, unknown>): ContextRuntimeBreakdown {
  return {
    pinned: Number(value.pinned ?? 0),
    checkpoint: Number(value.checkpoint ?? 0),
    recentTail: Number(value.recentTail ?? value.currentTurnTokens ?? 0),
    project: Number(value.project ?? value.systemTokens ?? 0),
    files: Number(value.files ?? value.relevantFileTokens ?? 0),
    toolObservations: Number(value.toolObservations ?? 0),
    memory: Number(value.memory ?? 0),
    systemTokens: Number(value.systemTokens ?? value.project ?? 0),
    goalTokens: Number(value.goalTokens ?? 0),
    currentUserTokens: Number(value.currentUserTokens ?? 0),
    relevantFileTokens: Number(value.relevantFileTokens ?? value.files ?? 0),
    currentTurnTokens: Number(value.currentTurnTokens ?? value.recentTail ?? 0),
    mandatoryTokens: Number(value.mandatoryTokens ?? 0),
  };
}

export class SqliteContextRuntimeStateRepository implements ContextRuntimeStateRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async upsert(state: ContextRuntimeState): Promise<void> {
    try {
      this.database.client
        .prepare(
          `INSERT INTO context_runtime_states
          (run_id, provider_id, model_id, profile_source, context_window_tokens,
           raw_context_window_tokens,
           effective_input_limit_tokens, estimated_input_tokens, remaining_tokens,
           pressure_state, compaction_count, last_compaction_at_ms, breakdown_json,
           last_build_status, last_build_at_ms, last_recovery_stages_json, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
           provider_id=excluded.provider_id, model_id=excluded.model_id,
           profile_source=excluded.profile_source, context_window_tokens=excluded.context_window_tokens,
           raw_context_window_tokens=excluded.raw_context_window_tokens,
           effective_input_limit_tokens=excluded.effective_input_limit_tokens,
           estimated_input_tokens=excluded.estimated_input_tokens, remaining_tokens=excluded.remaining_tokens,
           pressure_state=excluded.pressure_state, compaction_count=excluded.compaction_count,
           last_compaction_at_ms=excluded.last_compaction_at_ms, breakdown_json=excluded.breakdown_json,
           last_build_status=excluded.last_build_status, last_build_at_ms=excluded.last_build_at_ms,
           last_recovery_stages_json=excluded.last_recovery_stages_json,
           updated_at_ms=excluded.updated_at_ms`,
        )
        .run(
          state.runId,
          state.providerId,
          state.modelId,
          state.profileSource,
          state.contextWindowTokens,
          state.rawContextWindowTokens,
          state.effectiveInputLimitTokens,
          state.estimatedInputTokens,
          state.remainingTokens,
          state.pressureState,
          state.compactionCount,
          state.lastCompactionAt ?? null,
          JSON.stringify(state.breakdown),
          state.lastBuildStatus,
          state.lastBuildAt,
          JSON.stringify(state.lastRecoveryStages),
          state.updatedAt,
        );
    } catch (error) {
      throw new StorageError("Unable to persist context runtime state.", { cause: error });
    }
  }

  async getByRun(runId: string): Promise<ContextRuntimeState | undefined> {
    const row = this.database.client
      .prepare("SELECT * FROM context_runtime_states WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : decode(row);
  }
}
