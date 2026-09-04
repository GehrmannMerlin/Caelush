import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

export interface StoredStructuredCheckpoint {
  readonly version: 1;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly inProgress: readonly string[];
  readonly blocked: readonly string[];
  readonly importantDiscoveries: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly changedFiles: readonly string[];
  readonly readFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
  readonly activeProcesses: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly resourceGovernance: string;
  readonly criticalReferences: readonly string[];
  readonly nextIntent: string;
  readonly sourceRange: { readonly from: number; readonly to: number };
}

export interface ContextCheckpointCreateInput {
  readonly checkpointId: string;
  readonly runId: string;
  readonly previousCheckpointId?: string;
  readonly sourceSequenceFrom: number;
  readonly sourceSequenceTo: number;
  readonly structuredCheckpoint: StoredStructuredCheckpoint;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: { readonly providerId: string; readonly modelId: string };
  readonly createdAt: number;
}

export interface ContextCheckpointRecord {
  readonly checkpointId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly previousCheckpointId?: string;
  readonly sourceSequenceFrom: number;
  readonly sourceSequenceTo: number;
  readonly structuredCheckpoint: StoredStructuredCheckpoint;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: { readonly providerId: string; readonly modelId: string };
  readonly createdAt: number;
}

export interface ContextCheckpointRepository {
  create(input: ContextCheckpointCreateInput): Promise<ContextCheckpointRecord>;
  getLatestByRun(runId: string): Promise<ContextCheckpointRecord | undefined>;
  getById(checkpointId: string): Promise<ContextCheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly ContextCheckpointRecord[]>;
}

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

function decode(row: CheckpointRow): ContextCheckpointRecord {
  if (row.summary_version !== 1 || row.model_ref_json === null) {
    throw new StorageError("Context checkpoint schema is invalid.");
  }
  const modelRef = JSON.parse(row.model_ref_json) as {
    providerId?: unknown;
    modelId?: unknown;
  };
  if (typeof modelRef.providerId !== "string" || typeof modelRef.modelId !== "string") {
    throw new StorageError("Context checkpoint model reference is invalid.");
  }
  return Object.freeze({
    checkpointId: row.id,
    runId: row.run_id,
    schemaVersion: 1,
    ...(row.previous_checkpoint_id === null
      ? {}
      : { previousCheckpointId: row.previous_checkpoint_id }),
    sourceSequenceFrom: row.source_sequence_from,
    sourceSequenceTo: row.source_sequence_to,
    structuredCheckpoint: JSON.parse(
      row.data_json,
    ) as ContextCheckpointRecord["structuredCheckpoint"],
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    modelRef: Object.freeze({ providerId: modelRef.providerId, modelId: modelRef.modelId }),
    createdAt: row.created_at_ms,
  });
}

const SELECT = `SELECT id, run_id, previous_checkpoint_id, source_sequence_from,
  source_sequence_to, tokens_before, tokens_after, summary_version, model_ref_json,
  created_at_ms, data_json FROM context_checkpoints`;

export class SqliteContextCheckpointRepository implements ContextCheckpointRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async create(input: ContextCheckpointCreateInput): Promise<ContextCheckpointRecord> {
    const existing = this.database.client
      .prepare(
        `${SELECT} WHERE run_id = ? AND source_sequence_from = ? AND source_sequence_to = ?
         ORDER BY created_at_ms ASC, id ASC LIMIT 1`,
      )
      .get(input.runId, input.sourceSequenceFrom, input.sourceSequenceTo) as
      CheckpointRow | undefined;
    if (existing !== undefined) return decode(existing);
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
          input.sourceSequenceFrom,
          input.sourceSequenceTo,
          input.tokensBefore,
          input.tokensAfter,
          1,
          JSON.stringify(input.modelRef),
          input.createdAt,
          JSON.stringify(input.structuredCheckpoint),
          JSON.stringify(input.structuredCheckpoint.readFiles),
          JSON.stringify(input.structuredCheckpoint.changedFiles),
        );
    } catch (error) {
      throw new StorageError("Unable to persist context checkpoint.", { cause: error });
    }
    const saved = this.database.client.prepare(`${SELECT} WHERE id = ?`).get(input.checkpointId) as
      CheckpointRow | undefined;
    if (saved === undefined) throw new StorageError("Persisted context checkpoint is unavailable.");
    return decode(saved);
  }

  async getLatestByRun(runId: string): Promise<ContextCheckpointRecord | undefined> {
    const row = this.database.client
      .prepare(`${SELECT} WHERE run_id = ? ORDER BY source_sequence_to DESC, id DESC LIMIT 1`)
      .get(runId) as CheckpointRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  async getById(checkpointId: string): Promise<ContextCheckpointRecord | undefined> {
    const row = this.database.client.prepare(`${SELECT} WHERE id = ?`).get(checkpointId) as
      CheckpointRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  async listByRun(runId: string): Promise<readonly ContextCheckpointRecord[]> {
    const rows = this.database.client
      .prepare(`${SELECT} WHERE run_id = ? ORDER BY source_sequence_to ASC, id ASC`)
      .all(runId) as unknown as CheckpointRow[];
    return rows.map(decode);
  }
}
