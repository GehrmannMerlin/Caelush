import type {
  ContextCheckpointCreateInputV2,
  ContextCheckpointRecordV2,
  ContextCheckpointRepositoryPort,
  ContextCompactionReason,
  ContextMessageRange,
  ContextSummaryPromptVersion,
  LegacyContextCheckpointRecordV1,
  StructuredCheckpoint,
} from "@caelush/agent";
import {
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createStructuredCheckpoint,
} from "@caelush/agent";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageDecodeError, StorageError } from "./errors.js";
import { SqliteContextCheckpointRepository } from "./context-checkpoint-repository.js";

interface CheckpointRow {
  id: string;
  run_id: string;
  previous_checkpoint_id: string | null;
  source_sequence_from: number;
  source_sequence_to: number;
  tokens_before: number;
  tokens_after: number;
  summary_version: number;
  model_ref_json: string | null;
  created_at_ms: number;
  data_json: string;
}

interface V2DataEnvelope {
  readonly version: 2;
  readonly structuredCheckpoint: StructuredCheckpoint;
  readonly sourceRange: ContextMessageRange;
  readonly summaryPromptVersion: ContextSummaryPromptVersion;
  readonly sourceDigest: string;
  readonly checkpointDigest: string;
  readonly degraded: boolean;
  readonly reason: ContextCompactionReason;
}

const SELECT = `SELECT id, run_id, previous_checkpoint_id, source_sequence_from,
  source_sequence_to, tokens_before, tokens_after, summary_version, model_ref_json,
  created_at_ms, data_json FROM context_checkpoints`;

/** Parallel target-path repository for immutable V2 checkpoints. */
export class SqliteContextCheckpointRepositoryV2 implements ContextCheckpointRepositoryPort {
  private readonly legacy: SqliteContextCheckpointRepository;

  constructor(private readonly database: CaelushDatabase) {
    this.legacy = new SqliteContextCheckpointRepository(database);
  }

  async create(input: ContextCheckpointCreateInputV2): Promise<ContextCheckpointRecordV2> {
    assertCreateInput(input);
    const envelope: V2DataEnvelope = {
      version: 2,
      structuredCheckpoint: input.structuredCheckpoint,
      sourceRange: input.sourceRange,
      summaryPromptVersion: input.summaryPromptVersion,
      sourceDigest: input.sourceDigest,
      checkpointDigest: input.checkpointDigest,
      degraded: input.degraded,
      reason: input.reason,
    };
    try {
      this.database.client
        .prepare(
          `INSERT INTO context_checkpoints
           (id, run_id, previous_checkpoint_id, source_sequence_from, source_sequence_to,
            tokens_before, tokens_after, summary_version, model_ref_json, created_at_ms,
            data_json, read_file_refs_json, changed_file_refs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.checkpointId,
          input.runId,
          input.previousCheckpointId ?? null,
          input.sourceRange.firstSequence,
          input.sourceRange.lastSequence,
          input.tokensBefore,
          input.tokensAfter,
          2,
          JSON.stringify(input.modelRef),
          input.createdAt,
          JSON.stringify(envelope),
          JSON.stringify(input.structuredCheckpoint.readFiles),
          JSON.stringify(input.structuredCheckpoint.changedFiles),
        );
    } catch (error) {
      throw new StorageError("Unable to persist immutable Context Checkpoint V2.", {
        cause: error,
      });
    }
    const saved = this.database.client.prepare(`${SELECT} WHERE id = ?`).get(input.checkpointId) as
      CheckpointRow | undefined;
    if (saved === undefined)
      throw new StorageError("Persisted Context Checkpoint V2 is unavailable.");
    return decodeV2(saved);
  }

  async getLatestByRun(
    runId: RunId,
  ): Promise<ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined> {
    const row = this.database.client
      .prepare(`${SELECT} WHERE run_id = ? ORDER BY source_sequence_to DESC, id DESC LIMIT 1`)
      .get(runId) as CheckpointRow | undefined;
    return row === undefined ? undefined : this.decodeMixed(row);
  }

  async getById(
    checkpointId: string,
  ): Promise<ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined> {
    const row = this.database.client.prepare(`${SELECT} WHERE id = ?`).get(checkpointId) as
      CheckpointRow | undefined;
    return row === undefined ? undefined : this.decodeMixed(row);
  }

  async listByRun(
    runId: RunId,
  ): Promise<readonly (ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1)[]> {
    const rows = this.database.client
      .prepare(`${SELECT} WHERE run_id = ? ORDER BY source_sequence_to ASC, id ASC`)
      .all(runId) as unknown as CheckpointRow[];
    const records: (ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1)[] = [];
    for (const row of rows) records.push(await this.decodeMixed(row));
    return Object.freeze(records);
  }

  private async decodeMixed(
    row: CheckpointRow,
  ): Promise<ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1> {
    if (row.summary_version === 1) {
      const legacy = await this.legacy.getById(row.id);
      if (legacy === undefined) throw new StorageError("Context checkpoint is unavailable.");
      return legacy as LegacyContextCheckpointRecordV1;
    }
    return decodeV2(row);
  }
}

function assertCreateInput(input: ContextCheckpointCreateInputV2): void {
  if (input.sourceRange.runId !== input.runId) {
    throw new StorageError("Context Checkpoint V2 source range must belong to its Run.");
  }
  if (
    input.sourceRange.firstSequence < 1 ||
    input.sourceRange.lastSequence < input.sourceRange.firstSequence
  ) {
    throw new StorageError("Context Checkpoint V2 source range is invalid.");
  }
  if (
    !Number.isSafeInteger(input.tokensBefore) ||
    input.tokensBefore < 0 ||
    !Number.isSafeInteger(input.tokensAfter) ||
    input.tokensAfter < 0
  ) {
    throw new StorageError("Context Checkpoint V2 token estimates are invalid.");
  }
  if (input.structuredCheckpoint.sourceRange.from !== input.sourceRange.firstSequence) {
    throw new StorageError(
      "Context Checkpoint V2 payload source range does not match its envelope.",
    );
  }
  if (input.structuredCheckpoint.sourceRange.to !== input.sourceRange.lastSequence) {
    throw new StorageError(
      "Context Checkpoint V2 payload source range does not match its envelope.",
    );
  }
}

function decodeV2(row: CheckpointRow): ContextCheckpointRecordV2 {
  try {
    if (row.summary_version !== 2 || row.model_ref_json === null) {
      throw new Error("checkpoint V2 schema version or model reference is invalid");
    }
    requireNonNegative("tokens_before", row.tokens_before);
    requireNonNegative("tokens_after", row.tokens_after);
    requireNonNegative("created_at_ms", row.created_at_ms);
    const modelRef = parseModelRef(JSON.parse(row.model_ref_json));
    const envelope = parseEnvelope(JSON.parse(row.data_json));
    if (
      envelope.sourceRange.firstSequence !== row.source_sequence_from ||
      envelope.sourceRange.lastSequence !== row.source_sequence_to ||
      envelope.structuredCheckpoint.sourceRange.from !== row.source_sequence_from ||
      envelope.structuredCheckpoint.sourceRange.to !== row.source_sequence_to
    ) {
      throw new Error("checkpoint V2 source range is inconsistent");
    }
    return Object.freeze({
      checkpointId: createContextCheckpointId(row.id),
      runId: row.run_id as RunId,
      schemaVersion: 2,
      ...(row.previous_checkpoint_id === null
        ? {}
        : { previousCheckpointId: createContextCheckpointId(row.previous_checkpoint_id) }),
      sourceRange: envelope.sourceRange,
      structuredCheckpoint: envelope.structuredCheckpoint,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      modelRef,
      summaryPromptVersion: envelope.summaryPromptVersion,
      sourceDigest: envelope.sourceDigest,
      checkpointDigest: envelope.checkpointDigest,
      degraded: envelope.degraded,
      reason: envelope.reason,
      createdAt: row.created_at_ms as TimestampMs,
    });
  } catch (error) {
    if (error instanceof StorageDecodeError) throw error;
    throw new StorageDecodeError("ContextCheckpointV2", row.id, "context_checkpoints", {
      cause: error,
    });
  }
}

function parseEnvelope(value: unknown): V2DataEnvelope {
  const record = recordValue(value);
  const expected = [
    "version",
    "structuredCheckpoint",
    "sourceRange",
    "summaryPromptVersion",
    "sourceDigest",
    "checkpointDigest",
    "degraded",
    "reason",
  ] as const;
  if (!hasExactKeys(record, expected) || record.version !== 2) {
    throw new Error("checkpoint V2 data envelope is invalid");
  }
  const structuredCheckpoint = createStructuredCheckpoint(
    record.structuredCheckpoint as StructuredCheckpoint,
  );
  const sourceRange = parseSourceRange(record.sourceRange);
  if (
    !Number.isSafeInteger(record.summaryPromptVersion) ||
    (record.summaryPromptVersion as number) < 1 ||
    typeof record.sourceDigest !== "string" ||
    typeof record.checkpointDigest !== "string" ||
    typeof record.degraded !== "boolean" ||
    !isCompactionReason(record.reason)
  ) {
    throw new Error("checkpoint V2 data envelope metadata is invalid");
  }
  return {
    version: 2,
    structuredCheckpoint,
    sourceRange,
    summaryPromptVersion: createContextSummaryPromptVersion(record.summaryPromptVersion as number),
    sourceDigest: record.sourceDigest,
    checkpointDigest: record.checkpointDigest,
    degraded: record.degraded,
    reason: record.reason,
  };
}

function parseSourceRange(value: unknown): ContextMessageRange {
  const record = recordValue(value);
  if (
    !hasExactKeys(record, [
      "runId",
      "conversationTurnId",
      "firstMessageId",
      "lastMessageId",
      "firstSequence",
      "lastSequence",
    ])
  ) {
    throw new Error("checkpoint V2 source range is invalid");
  }
  return createContextMessageRange({
    runId: text(record.runId, "sourceRange.runId") as RunId,
    conversationTurnId: text(record.conversationTurnId, "sourceRange.conversationTurnId") as never,
    firstMessageId: text(record.firstMessageId, "sourceRange.firstMessageId") as never,
    lastMessageId: text(record.lastMessageId, "sourceRange.lastMessageId") as never,
    firstSequence: integer(record.firstSequence, "sourceRange.firstSequence"),
    lastSequence: integer(record.lastSequence, "sourceRange.lastSequence"),
  });
}

function parseModelRef(value: unknown): ContextCheckpointRecordV2["modelRef"] {
  const record = recordValue(value);
  if (
    !hasExactKeys(record, [
      "provider",
      "model",
      ...(Object.hasOwn(record, "baseUrl") ? ["baseUrl"] : []),
    ])
  ) {
    throw new Error("checkpoint V2 model reference is invalid");
  }
  return Object.freeze({
    provider: text(record.provider, "modelRef.provider"),
    model: text(record.model, "modelRef.model"),
    ...(record.baseUrl === undefined ? {} : { baseUrl: text(record.baseUrl, "modelRef.baseUrl") }),
  });
}

function requireNonNegative(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} is invalid`);
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} is invalid`);
  return value as number;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is invalid`);
  return value;
}

function isCompactionReason(value: unknown): value is ContextCompactionReason {
  return (
    value === "PROACTIVE_PRESSURE" ||
    value === "SELECTION_PRESSURE" ||
    value === "FORCED_PROVIDER_OVERFLOW"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("value must be an object");
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
