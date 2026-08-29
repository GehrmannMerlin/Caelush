import { RunContinuationCheckpointSchema, type RunContinuationCheckpoint } from "@caelush/core";
import type { RunId, TimestampMs } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "../errors.js";

interface ContinuationRow {
  run_id: string;
  kind: string;
  source_step_id: string;
  revision: number;
  updated_at_ms: number;
  data_json: string;
}

export interface StoredContinuation {
  readonly checkpoint: RunContinuationCheckpoint;
  readonly revision: number;
  readonly updatedAt: TimestampMs;
}

export interface ContinuationRepository {
  get(runId: RunId): Promise<StoredContinuation | null>;
  set(
    runId: RunId,
    checkpoint: RunContinuationCheckpoint,
    updatedAt: TimestampMs,
    expectedRevision: number | null,
  ): Promise<StoredContinuation>;
  clear(runId: RunId, expectedRevision: number): Promise<void>;
}

function decodeContinuation(row: ContinuationRow): StoredContinuation {
  const checkpoint = decodeProtocol(RunContinuationCheckpointSchema, row.data_json, {
    entityType: "RunContinuationCheckpoint",
    entityId: row.run_id,
    table: "agent_run_continuations",
  });
  if (
    checkpoint.runId !== row.run_id ||
    checkpoint.type !== row.kind ||
    checkpoint.sourceStepId !== row.source_step_id ||
    row.revision < 1
  ) {
    throw new StorageDecodeError(
      "RunContinuationCheckpoint",
      row.run_id,
      "agent_run_continuations",
    );
  }
  return {
    checkpoint,
    revision: row.revision,
    updatedAt: row.updated_at_ms as TimestampMs,
  };
}

function mapError(error: unknown, runId: RunId): never {
  if (error instanceof StorageError) throw error;
  throw new StorageError(`Unable to persist continuation for Run ${runId}`, { cause: error });
}

function assertExpectedRevision(
  actual: number | undefined,
  expected: number | null,
  runId: RunId,
): void {
  const normalized = actual ?? null;
  if (normalized !== expected) {
    throw new StorageConflictError(
      `Continuation revision conflict for Run ${runId}: expected ${String(expected)}, actual ${String(normalized)}`,
    );
  }
}

export function setContinuationInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  checkpoint: RunContinuationCheckpoint,
  updatedAt: TimestampMs,
  expectedRevision: number | null,
): StoredContinuation {
  const parsed = RunContinuationCheckpointSchema.parse(checkpoint);
  if (parsed.runId !== runId) {
    throw new StorageDecodeError("RunContinuationCheckpoint", runId, "agent_run_continuations");
  }
  const existing = client
    .prepare("SELECT revision FROM agent_run_continuations WHERE run_id = ?")
    .get(runId) as { revision: number } | undefined;
  assertExpectedRevision(existing?.revision, expectedRevision, runId);
  const revision = (existing?.revision ?? 0) + 1;
  const dataJson = encodeProtocol(RunContinuationCheckpointSchema, parsed, {
    entityType: "RunContinuationCheckpoint",
    entityId: runId,
    table: "agent_run_continuations",
  });
  if (existing) {
    client
      .prepare(
        `UPDATE agent_run_continuations
         SET kind = ?, source_step_id = ?, revision = ?, updated_at_ms = ?, data_json = ?
         WHERE run_id = ?`,
      )
      .run(parsed.type, parsed.sourceStepId, revision, updatedAt, dataJson, runId);
  } else {
    client
      .prepare(
        `INSERT INTO agent_run_continuations
         (run_id, kind, source_step_id, revision, updated_at_ms, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, parsed.type, parsed.sourceStepId, revision, updatedAt, dataJson);
  }
  return { checkpoint: parsed, revision, updatedAt };
}

export function clearContinuationInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  expectedRevision: number | null,
): void {
  const existing = client
    .prepare("SELECT revision FROM agent_run_continuations WHERE run_id = ?")
    .get(runId) as { revision: number } | undefined;
  assertExpectedRevision(existing?.revision, expectedRevision, runId);
  client.prepare("DELETE FROM agent_run_continuations WHERE run_id = ?").run(runId);
}

export class SqliteContinuationRepository implements ContinuationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(runId: RunId): Promise<StoredContinuation | null> {
    const row = this.database.client
      .prepare(
        `SELECT run_id, kind, source_step_id, revision, updated_at_ms, data_json
         FROM agent_run_continuations WHERE run_id = ?`,
      )
      .get(runId) as ContinuationRow | undefined;
    return row ? decodeContinuation(row) : null;
  }

  async set(
    runId: RunId,
    checkpoint: RunContinuationCheckpoint,
    updatedAt: TimestampMs,
    expectedRevision: number | null,
  ): Promise<StoredContinuation> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const result = setContinuationInTransaction(
        client,
        runId,
        checkpoint,
        updatedAt,
        expectedRevision,
      );
      client.exec("COMMIT");
      return result;
    } catch (error) {
      client.exec("ROLLBACK");
      mapError(error, runId);
    }
  }

  async clear(runId: RunId, expectedRevision: number): Promise<void> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      clearContinuationInTransaction(client, runId, expectedRevision);
      client.exec("COMMIT");
    } catch (error) {
      client.exec("ROLLBACK");
      mapError(error, runId);
    }
  }
}
