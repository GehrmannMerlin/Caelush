import type {
  ContextUsageSnapshot,
  ContextUsageSourceBreakdown,
  ContextUsageStorePort,
} from "@caelush/agent";
import type { RunId } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageDecodeError, StorageError } from "./errors.js";

interface UsageRow {
  run_id: string;
  provider_id: string;
  model_id: string;
  context_window_tokens: number;
  effective_input_limit_tokens: number;
  estimated_input_tokens: number;
  remaining_tokens: number;
  pressure_state: string;
  compaction_count: number;
  last_compaction_at_ms: number | null;
  breakdown_json: string;
  last_build_status: string;
  last_build_at_ms: number;
  updated_at_ms: number;
}

interface UsageEnvelope {
  readonly version: 2;
  readonly breakdown: readonly ContextUsageSourceBreakdown[];
  readonly contextFingerprint: string | null;
}

export class SqliteContextUsageStore implements ContextUsageStorePort {
  constructor(private readonly database: CaelushDatabase) {}

  async upsert(snapshot: ContextUsageSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    const breakdown = [...snapshot.breakdown].sort((left, right) =>
      compareStrings(left.sourceId, right.sourceId),
    );
    const envelope: UsageEnvelope = {
      version: 2,
      breakdown,
      contextFingerprint: snapshot.contextFingerprint ?? null,
    };
    try {
      this.database.client
        .prepare(
          `INSERT INTO context_runtime_states
           (run_id, provider_id, model_id, profile_source, context_window_tokens,
            raw_context_window_tokens, effective_input_limit_tokens, estimated_input_tokens,
            remaining_tokens, pressure_state, compaction_count, last_compaction_at_ms,
            breakdown_json, last_build_status, last_build_at_ms, last_recovery_stages_json,
            updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
            provider_id = excluded.provider_id,
            model_id = excluded.model_id,
            profile_source = excluded.profile_source,
            context_window_tokens = excluded.context_window_tokens,
            raw_context_window_tokens = excluded.raw_context_window_tokens,
            effective_input_limit_tokens = excluded.effective_input_limit_tokens,
            estimated_input_tokens = excluded.estimated_input_tokens,
            remaining_tokens = excluded.remaining_tokens,
            pressure_state = excluded.pressure_state,
            compaction_count = excluded.compaction_count,
            last_compaction_at_ms = excluded.last_compaction_at_ms,
            breakdown_json = excluded.breakdown_json,
            last_build_status = excluded.last_build_status,
            last_build_at_ms = excluded.last_build_at_ms,
            last_recovery_stages_json = excluded.last_recovery_stages_json,
            updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          snapshot.runId,
          snapshot.modelRef.provider,
          snapshot.modelRef.model,
          "CONFIGURATION",
          snapshot.contextWindowTokens,
          snapshot.contextWindowTokens,
          snapshot.effectiveInputLimitTokens,
          snapshot.estimatedInputTokens,
          snapshot.remainingTokens,
          snapshot.pressureState,
          snapshot.compactionCount,
          snapshot.lastCompactionAt ?? null,
          JSON.stringify(envelope),
          snapshot.lastBuildStatus,
          snapshot.updatedAt,
          "[]",
          snapshot.updatedAt,
        );
    } catch (error) {
      throw new StorageError("Unable to persist Context Usage V2.", { cause: error });
    }
  }

  async getByRun(runId: RunId): Promise<ContextUsageSnapshot | undefined> {
    const row = this.database.client
      .prepare(
        `SELECT run_id, provider_id, model_id, context_window_tokens,
                effective_input_limit_tokens, estimated_input_tokens, remaining_tokens,
                pressure_state, compaction_count, last_compaction_at_ms, breakdown_json,
                last_build_status, last_build_at_ms, updated_at_ms
         FROM context_runtime_states WHERE run_id = ?`,
      )
      .get(runId) as UsageRow | undefined;
    return row === undefined ? undefined : decodeUsage(row);
  }
}

function assertSnapshot(snapshot: ContextUsageSnapshot): void {
  if (!snapshot.runId || !snapshot.modelRef.provider || !snapshot.modelRef.model) {
    throw new StorageError("Context Usage identity is invalid.");
  }
  for (const [value, label] of [
    [snapshot.contextWindowTokens, "contextWindowTokens"],
    [snapshot.effectiveInputLimitTokens, "effectiveInputLimitTokens"],
    [snapshot.estimatedInputTokens, "estimatedInputTokens"],
    [snapshot.remainingTokens, "remainingTokens"],
    [snapshot.compactionCount, "compactionCount"],
    [snapshot.updatedAt, "updatedAt"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new StorageError(`Context Usage ${label} is invalid.`);
  }
  if (snapshot.effectiveInputLimitTokens > snapshot.contextWindowTokens) {
    throw new StorageError("Context Usage effective input limit is invalid.");
  }
  if (!(
    snapshot.pressureState === "NORMAL" ||
    snapshot.pressureState === "PROACTIVE" ||
    snapshot.pressureState === "EMERGENCY"
  )) {
    throw new StorageError("Context Usage pressure is invalid.");
  }
  if (!(
    snapshot.lastBuildStatus === "SUCCESS" ||
    snapshot.lastBuildStatus === "FAILED" ||
    snapshot.lastBuildStatus === "CONTEXT_EXHAUSTED"
  )) {
    throw new StorageError("Context Usage build status is invalid.");
  }
  const ids = new Set<string>();
  for (const item of snapshot.breakdown) {
    if (!item.sourceId || ids.has(item.sourceId))
      throw new StorageError("Context Usage source breakdown is invalid.");
    ids.add(item.sourceId);
    if (
      !Number.isSafeInteger(item.tokens) ||
      item.tokens < 0 ||
      !Number.isSafeInteger(item.itemCount) ||
      item.itemCount < 0
    ) {
      throw new StorageError("Context Usage source breakdown values are invalid.");
    }
  }
}

function decodeUsage(row: UsageRow): ContextUsageSnapshot {
  try {
    if (!Number.isSafeInteger(row.context_window_tokens) || row.context_window_tokens < 0)
      throw new Error("invalid context window");
    if (
      !Number.isSafeInteger(row.effective_input_limit_tokens) ||
      row.effective_input_limit_tokens < 0 ||
      row.effective_input_limit_tokens > row.context_window_tokens
    )
      throw new Error("invalid input limit");
    for (const value of [
      row.estimated_input_tokens,
      row.remaining_tokens,
      row.compaction_count,
      row.last_build_at_ms,
      row.updated_at_ms,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid usage number");
    }
    if (!(
      row.pressure_state === "NORMAL" ||
      row.pressure_state === "PROACTIVE" ||
      row.pressure_state === "EMERGENCY"
    ))
      throw new Error("invalid pressure");
    if (!(
      row.last_build_status === "SUCCESS" ||
      row.last_build_status === "FAILED" ||
      row.last_build_status === "CONTEXT_EXHAUSTED"
    ))
      throw new Error("invalid build status");
    if (
      row.last_compaction_at_ms !== null &&
      (!Number.isSafeInteger(row.last_compaction_at_ms) || row.last_compaction_at_ms < 0)
    )
      throw new Error("invalid compaction timestamp");
    const envelope = JSON.parse(row.breakdown_json) as unknown;
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error("invalid usage envelope");
    const candidate = envelope as Record<string, unknown>;
    if (
      candidate.version !== 2 ||
      !Array.isArray(candidate.breakdown) ||
      (candidate.contextFingerprint !== null && typeof candidate.contextFingerprint !== "string")
    )
      throw new Error("invalid usage envelope");
    const breakdown = candidate.breakdown.map((item) => decodeBreakdown(item));
    const ids = breakdown.map((item) => item.sourceId);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate usage source");
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      throw new Error("usage sources are not ordered");
    return Object.freeze({
      runId: row.run_id as RunId,
      modelRef: Object.freeze({ provider: text(row.provider_id), model: text(row.model_id) }),
      contextWindowTokens: row.context_window_tokens,
      effectiveInputLimitTokens: row.effective_input_limit_tokens,
      estimatedInputTokens: row.estimated_input_tokens,
      remainingTokens: row.remaining_tokens,
      pressureState: row.pressure_state,
      compactionCount: row.compaction_count,
      ...(row.last_compaction_at_ms === null
        ? {}
        : { lastCompactionAt: row.last_compaction_at_ms as ContextUsageSnapshot["updatedAt"] }),
      breakdown: Object.freeze(breakdown),
      lastBuildStatus: row.last_build_status,
      ...(candidate.contextFingerprint === null
        ? {}
        : { contextFingerprint: candidate.contextFingerprint as never }),
      updatedAt: row.updated_at_ms as ContextUsageSnapshot["updatedAt"],
    });
  } catch (error) {
    throw new StorageDecodeError("ContextUsage", row.run_id, "context_runtime_states", {
      cause: error,
    });
  }
}

function decodeBreakdown(value: unknown): ContextUsageSourceBreakdown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid source breakdown");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceId !== "string" ||
    candidate.sourceId.length === 0 ||
    !Number.isSafeInteger(candidate.tokens) ||
    (candidate.tokens as number) < 0 ||
    !Number.isSafeInteger(candidate.itemCount) ||
    (candidate.itemCount as number) < 0
  )
    throw new Error("invalid source breakdown");
  return Object.freeze({
    sourceId: candidate.sourceId,
    tokens: candidate.tokens as number,
    itemCount: candidate.itemCount as number,
  });
}

function text(value: string): string {
  if (value.trim().length === 0) throw new Error("empty text");
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
