import type { LLMCallId, PromptCacheRequestPurpose, RunId, TimestampMs } from "@caelush/protocol";
import { StorageConflictError, StorageError } from "./errors.js";
import type { CaelushDatabase } from "./database.js";

export type ProviderInvocationStatus = "OBSERVED" | "COMPLETE" | "FAILED" | "CANCELLED";

export interface ProviderInvocationUsageRecord {
  readonly callId: LLMCallId;
  readonly runId: RunId;
  readonly purpose: PromptCacheRequestPurpose;
  readonly status: ProviderInvocationStatus;
  readonly providerId: string;
  readonly modelId: string;
  readonly api: string;
  readonly continuityGroup: string;
  readonly cacheEpochId?: string;
  readonly prefixFingerprint?: string;
  readonly requestFingerprint: string;
  readonly observedAt: TimestampMs;
  readonly settledAt?: TimestampMs;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheHitInputTokens?: number;
  readonly cacheMissInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ProviderInvocationObservationInput {
  readonly callId: LLMCallId;
  readonly runId: RunId;
  readonly purpose: PromptCacheRequestPurpose;
  readonly providerId: string;
  readonly modelId: string;
  readonly api: string;
  readonly continuityGroup: string;
  readonly cacheEpochId?: string;
  readonly prefixFingerprint?: string;
  readonly requestFingerprint: string;
  readonly observedAt: TimestampMs;
}

export class SqliteProviderInvocationUsageStore {
  constructor(private readonly database: CaelushDatabase) {}

  async observe(input: ProviderInvocationObservationInput): Promise<ProviderInvocationUsageRecord> {
    validateObservation(input);
    const existing = await this.get(input.callId);
    if (existing !== null) {
      if (!sameObservation(existing, input)) {
        throw new StorageConflictError(
          "Provider call identity already belongs to another request.",
        );
      }
      return existing;
    }
    try {
      this.database.client
        .prepare(
          `INSERT INTO provider_invocation_usage
           (call_id, run_id, purpose, status, provider_id, model_id, api, continuity_group,
            cache_epoch_id, prefix_fingerprint, request_fingerprint, observed_at_ms)
           VALUES (?, ?, ?, 'OBSERVED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.callId,
          input.runId,
          input.purpose,
          input.providerId,
          input.modelId,
          input.api,
          input.continuityGroup,
          input.cacheEpochId ?? null,
          input.prefixFingerprint ?? null,
          input.requestFingerprint,
          input.observedAt,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new StorageConflictError("Provider call identity conflicts with another request.", {
          cause: error,
        });
      }
      throw new StorageError("Unable to persist Provider request identity.", { cause: error });
    }
    const stored = await this.get(input.callId);
    if (stored === null) throw new StorageError("Provider request identity was not persisted.");
    return stored;
  }

  async settle(input: {
    readonly callId: LLMCallId;
    readonly status: Exclude<ProviderInvocationStatus, "OBSERVED">;
    readonly settledAt: TimestampMs;
    readonly totalTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheHitInputTokens?: number;
    readonly cacheMissInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly reasoningTokens?: number;
  }): Promise<void> {
    validateCounters(input);
    const existing = await this.get(input.callId);
    if (existing === null) throw new StorageError("Provider request identity is missing.");
    if (existing.status !== "OBSERVED") {
      if (sameSettlement(existing, input)) return;
      throw new StorageConflictError("Provider usage for a settled call cannot be overwritten.");
    }
    const result = this.database.client
      .prepare(
        `UPDATE provider_invocation_usage SET status = ?, settled_at_ms = ?, total_tokens = ?, input_tokens = ?,
         output_tokens = ?, cache_hit_input_tokens = ?, cache_miss_input_tokens = ?,
         cache_write_input_tokens = ?, reasoning_tokens = ?
         WHERE call_id = ? AND status = 'OBSERVED'`,
      )
      .run(
        input.status,
        input.settledAt,
        input.totalTokens ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheHitInputTokens ?? null,
        input.cacheMissInputTokens ?? null,
        input.cacheWriteInputTokens ?? null,
        input.reasoningTokens ?? null,
        input.callId,
      );
    if (result.changes !== 1) {
      throw new StorageConflictError("Provider invocation changed while its usage was settling.");
    }
  }

  async get(callId: LLMCallId): Promise<ProviderInvocationUsageRecord | null> {
    const row = this.database.client
      .prepare("SELECT * FROM provider_invocation_usage WHERE call_id = ?")
      .get(callId) as ProviderInvocationRow | undefined;
    return row === undefined ? null : decode(row);
  }

  async listByRun(runId: RunId): Promise<readonly ProviderInvocationUsageRecord[]> {
    const rows = this.database.client
      .prepare(
        "SELECT * FROM provider_invocation_usage WHERE run_id = ? ORDER BY observed_at_ms ASC, call_id ASC",
      )
      .all(runId) as unknown as ProviderInvocationRow[];
    return Object.freeze(rows.map(decode));
  }
}

interface ProviderInvocationRow {
  call_id: string;
  run_id: string;
  purpose: string;
  status: string;
  provider_id: string;
  model_id: string;
  api: string;
  continuity_group: string;
  cache_epoch_id: string | null;
  prefix_fingerprint: string | null;
  request_fingerprint: string;
  observed_at_ms: number;
  settled_at_ms: number | null;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_input_tokens: number | null;
  cache_miss_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  reasoning_tokens: number | null;
}

function decode(row: ProviderInvocationRow): ProviderInvocationUsageRecord {
  if (!isPurpose(row.purpose) || !isStatus(row.status)) {
    throw new StorageError("Provider invocation row contains an unsupported lifecycle value.");
  }
  return {
    callId: row.call_id as LLMCallId,
    runId: row.run_id as RunId,
    purpose: row.purpose,
    status: row.status,
    providerId: row.provider_id,
    modelId: row.model_id,
    api: row.api,
    continuityGroup: row.continuity_group,
    ...(row.cache_epoch_id === null ? {} : { cacheEpochId: row.cache_epoch_id }),
    ...(row.prefix_fingerprint === null ? {} : { prefixFingerprint: row.prefix_fingerprint }),
    requestFingerprint: row.request_fingerprint,
    observedAt: row.observed_at_ms as TimestampMs,
    ...(row.settled_at_ms === null ? {} : { settledAt: row.settled_at_ms as TimestampMs }),
    ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.cache_hit_input_tokens === null
      ? {}
      : { cacheHitInputTokens: row.cache_hit_input_tokens }),
    ...(row.cache_miss_input_tokens === null
      ? {}
      : { cacheMissInputTokens: row.cache_miss_input_tokens }),
    ...(row.cache_write_input_tokens === null
      ? {}
      : { cacheWriteInputTokens: row.cache_write_input_tokens }),
    ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
  };
}

function sameObservation(
  existing: ProviderInvocationUsageRecord,
  input: ProviderInvocationObservationInput,
): boolean {
  return (
    existing.callId === input.callId &&
    existing.runId === input.runId &&
    existing.purpose === input.purpose &&
    existing.providerId === input.providerId &&
    existing.modelId === input.modelId &&
    existing.api === input.api &&
    existing.continuityGroup === input.continuityGroup &&
    existing.cacheEpochId === input.cacheEpochId &&
    existing.prefixFingerprint === input.prefixFingerprint &&
    existing.requestFingerprint === input.requestFingerprint
  );
}

function sameSettlement(
  existing: ProviderInvocationUsageRecord,
  input: {
    readonly status: Exclude<ProviderInvocationStatus, "OBSERVED">;
    readonly totalTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheHitInputTokens?: number;
    readonly cacheMissInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly reasoningTokens?: number;
  },
): boolean {
  return (
    existing.status === input.status &&
    existing.totalTokens === input.totalTokens &&
    existing.inputTokens === input.inputTokens &&
    existing.outputTokens === input.outputTokens &&
    existing.cacheHitInputTokens === input.cacheHitInputTokens &&
    existing.cacheMissInputTokens === input.cacheMissInputTokens &&
    existing.cacheWriteInputTokens === input.cacheWriteInputTokens &&
    existing.reasoningTokens === input.reasoningTokens
  );
}

function validateObservation(input: ProviderInvocationObservationInput): void {
  if (
    !isPurpose(input.purpose) ||
    !input.callId ||
    !input.providerId ||
    !input.modelId ||
    !input.api ||
    !isFingerprint(input.continuityGroup) ||
    !isFingerprint(input.requestFingerprint) ||
    (input.prefixFingerprint !== undefined && !isFingerprint(input.prefixFingerprint)) ||
    (input.cacheEpochId !== undefined && !isFingerprint(input.cacheEpochId))
  ) {
    throw new TypeError("Provider invocation accounting identity is invalid.");
  }
}

function validateCounters(input: {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheHitInputTokens?: number;
  readonly cacheMissInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
}): void {
  const counters = [
    input.inputTokens,
    input.outputTokens,
    input.totalTokens,
    input.cacheHitInputTokens,
    input.cacheMissInputTokens,
    input.cacheWriteInputTokens,
    input.reasoningTokens,
  ];
  for (const count of counters) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      throw new TypeError("Provider usage counters must be non-negative safe integers.");
    }
  }
}

function isFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isPurpose(value: string): value is PromptCacheRequestPurpose {
  return [
    "MAIN_AGENT",
    "VERIFICATION_LLM",
    "CONTEXT_COMPACTION",
    "WARMUP",
    "RETRY",
    "COMPACTION",
    "TITLE",
    "OTHER",
  ].includes(value);
}

function isStatus(value: string): value is ProviderInvocationStatus {
  return ["OBSERVED", "COMPLETE", "FAILED", "CANCELLED"].includes(value);
}
