import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

export type ContextRuntimeState = {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSource:
    "CONFIGURATION" | "KNOWN_METADATA" | "LEGACY_LIMITS" | "OVERRIDE" | "FALLBACK";
  readonly contextWindowTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly estimatedInputTokens: number;
  readonly remainingTokens: number;
  readonly pressureState: "NORMAL" | "PROACTIVE" | "EMERGENCY";
  readonly compactionCount: number;
  readonly lastCompactionAt?: number;
  readonly breakdown: {
    readonly pinned: number;
    readonly checkpoint: number;
    readonly recentTail: number;
    readonly project: number;
    readonly files: number;
    readonly toolObservations: number;
    readonly memory: number;
  };
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
    effectiveInputLimitTokens: Number(row.effective_input_limit_tokens),
    estimatedInputTokens: Number(row.estimated_input_tokens),
    remainingTokens: Number(row.remaining_tokens),
    pressureState: String(row.pressure_state) as ContextRuntimeState["pressureState"],
    compactionCount: Number(row.compaction_count),
    ...(row.last_compaction_at_ms === null
      ? {}
      : { lastCompactionAt: Number(row.last_compaction_at_ms) }),
    breakdown: JSON.parse(String(row.breakdown_json)) as ContextRuntimeBreakdown,
    lastBuildStatus: String(row.last_build_status) as ContextRuntimeState["lastBuildStatus"],
    updatedAt: Number(row.updated_at_ms),
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
           effective_input_limit_tokens, estimated_input_tokens, remaining_tokens,
           pressure_state, compaction_count, last_compaction_at_ms, breakdown_json,
           last_build_status, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
           provider_id=excluded.provider_id, model_id=excluded.model_id,
           profile_source=excluded.profile_source, context_window_tokens=excluded.context_window_tokens,
           effective_input_limit_tokens=excluded.effective_input_limit_tokens,
           estimated_input_tokens=excluded.estimated_input_tokens, remaining_tokens=excluded.remaining_tokens,
           pressure_state=excluded.pressure_state, compaction_count=excluded.compaction_count,
           last_compaction_at_ms=excluded.last_compaction_at_ms, breakdown_json=excluded.breakdown_json,
           last_build_status=excluded.last_build_status, updated_at_ms=excluded.updated_at_ms`,
        )
        .run(
          state.runId,
          state.providerId,
          state.modelId,
          state.profileSource,
          state.contextWindowTokens,
          state.effectiveInputLimitTokens,
          state.estimatedInputTokens,
          state.remainingTokens,
          state.pressureState,
          state.compactionCount,
          state.lastCompactionAt ?? null,
          JSON.stringify(state.breakdown),
          state.lastBuildStatus,
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
