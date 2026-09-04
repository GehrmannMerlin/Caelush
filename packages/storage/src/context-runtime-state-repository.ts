import type { CaelushDatabase } from "./database.js";
import { StorageDecodeError, StorageError } from "./errors.js";

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
  let runId =
    typeof row.run_id === "string" && row.run_id.trim() !== "" ? row.run_id : "<invalid-run-id>";
  try {
    runId = requiredString(row.run_id, "run_id");
    const profileSource = requiredEnum(
      row.profile_source,
      ["CONFIGURATION", "KNOWN_METADATA", "LEGACY_LIMITS", "OVERRIDE", "FALLBACK"],
      "profile_source",
    ) as ContextRuntimeState["profileSource"];
    const pressureState = requiredEnum(
      row.pressure_state,
      ["NORMAL", "PROACTIVE", "EMERGENCY"],
      "pressure_state",
    ) as ContextRuntimeState["pressureState"];
    const lastBuildStatus = requiredEnum(
      row.last_build_status,
      ["SUCCESS", "FAILED", "CONTEXT_EXHAUSTED"],
      "last_build_status",
    ) as ContextRuntimeState["lastBuildStatus"];
    const contextWindowTokens = safeNonNegativeNumber(
      row.context_window_tokens,
      "context_window_tokens",
    );
    const rawContextWindowTokens = safeNonNegativeNumber(
      row.raw_context_window_tokens ?? row.context_window_tokens,
      "raw_context_window_tokens",
    );
    const effectiveInputLimitTokens = safeNonNegativeNumber(
      row.effective_input_limit_tokens,
      "effective_input_limit_tokens",
    );
    if (effectiveInputLimitTokens > rawContextWindowTokens) {
      throw new Error("effective_input_limit_tokens exceeds raw_context_window_tokens");
    }
    const lastCompactionAt = optionalSafeNonNegativeNumber(
      row.last_compaction_at_ms,
      "last_compaction_at_ms",
    );
    const lastBuildAt = safeNonNegativeNumber(
      row.last_build_at_ms ?? row.updated_at_ms,
      "last_build_at_ms",
    );
    const lastRecoveryStages = decodeRecoveryStages(row.last_recovery_stages_json);
    return Object.freeze({
      runId,
      providerId: requiredString(row.provider_id, "provider_id"),
      modelId: requiredString(row.model_id, "model_id"),
      profileSource,
      contextWindowTokens,
      rawContextWindowTokens,
      effectiveInputLimitTokens,
      estimatedInputTokens: safeNonNegativeNumber(
        row.estimated_input_tokens,
        "estimated_input_tokens",
      ),
      remainingTokens: safeNonNegativeNumber(row.remaining_tokens, "remaining_tokens"),
      pressureState,
      compactionCount: safeNonNegativeNumber(row.compaction_count, "compaction_count"),
      ...(lastCompactionAt === undefined ? {} : { lastCompactionAt }),
      lastBuildAt,
      breakdown: normalizeBreakdown(
        JSON.parse(requiredString(row.breakdown_json, "breakdown_json")) as unknown,
      ),
      lastRecoveryStages,
      lastBuildStatus,
      updatedAt: safeNonNegativeNumber(row.updated_at_ms, "updated_at_ms"),
    });
  } catch (error) {
    if (error instanceof StorageDecodeError) throw error;
    throw new StorageDecodeError("ContextRuntimeState", runId, "context_runtime_states", {
      cause: error,
    });
  }
}

function normalizeBreakdown(value: unknown): ContextRuntimeBreakdown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("breakdown_json must contain an object");
  }
  const record = value as Record<string, unknown>;
  return {
    pinned: safeNonNegativeNumber(record.pinned ?? 0, "breakdown.pinned"),
    checkpoint: safeNonNegativeNumber(record.checkpoint ?? 0, "breakdown.checkpoint"),
    recentTail: safeNonNegativeNumber(
      record.recentTail ?? record.currentTurnTokens ?? 0,
      "breakdown.recentTail",
    ),
    project: safeNonNegativeNumber(record.project ?? record.systemTokens ?? 0, "breakdown.project"),
    files: safeNonNegativeNumber(record.files ?? record.relevantFileTokens ?? 0, "breakdown.files"),
    toolObservations: safeNonNegativeNumber(
      record.toolObservations ?? 0,
      "breakdown.toolObservations",
    ),
    memory: safeNonNegativeNumber(record.memory ?? 0, "breakdown.memory"),
    systemTokens: safeNonNegativeNumber(
      record.systemTokens ?? record.project ?? 0,
      "breakdown.systemTokens",
    ),
    goalTokens: safeNonNegativeNumber(record.goalTokens ?? 0, "breakdown.goalTokens"),
    currentUserTokens: safeNonNegativeNumber(
      record.currentUserTokens ?? 0,
      "breakdown.currentUserTokens",
    ),
    relevantFileTokens: safeNonNegativeNumber(
      record.relevantFileTokens ?? record.files ?? 0,
      "breakdown.relevantFileTokens",
    ),
    currentTurnTokens: safeNonNegativeNumber(
      record.currentTurnTokens ?? record.recentTail ?? 0,
      "breakdown.currentTurnTokens",
    ),
    mandatoryTokens: safeNonNegativeNumber(
      record.mandatoryTokens ?? 0,
      "breakdown.mandatoryTokens",
    ),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is invalid`);
  return value;
}

function requiredEnum(value: unknown, allowed: readonly string[], name: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function safeNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalSafeNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return safeNonNegativeNumber(value, name);
}

function decodeRecoveryStages(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const parsed = JSON.parse(requiredString(value, "last_recovery_stages_json")) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    parsed.some((stage) => typeof stage !== "string" || stage.trim() === "")
  ) {
    throw new Error("last_recovery_stages_json is invalid");
  }
  return Object.freeze([...parsed]);
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
