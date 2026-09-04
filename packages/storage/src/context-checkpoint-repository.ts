import type { CaelushDatabase } from "./database.js";
import { StorageDecodeError, StorageError } from "./errors.js";

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
  readonly sourceRange: {
    readonly from: number;
    readonly to: number;
    readonly kind?: "DURABLE_MESSAGE_SEQUENCE" | "LOCAL_HISTORY_INDEX";
  };
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
  updateTokensAfter(checkpointId: string, tokensAfter: number): Promise<void>;
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
  try {
    if (row.summary_version !== 1 || row.model_ref_json === null) {
      throw new Error("checkpoint schema version or model reference is invalid");
    }
    requireSafeNonNegative("source_sequence_from", row.source_sequence_from);
    requireSafeNonNegative("source_sequence_to", row.source_sequence_to);
    requireSafeNonNegative("tokens_before", row.tokens_before);
    requireSafeNonNegative("tokens_after", row.tokens_after);
    requireSafeNonNegative("created_at_ms", row.created_at_ms);
    if (row.source_sequence_from > row.source_sequence_to) {
      throw new Error("checkpoint source sequence range is invalid");
    }
    const modelRef = parseModelRef(JSON.parse(row.model_ref_json));
    const structured = parseStructuredCheckpoint(JSON.parse(row.data_json));
    if (
      structured.sourceRange.from > structured.sourceRange.to ||
      structured.sourceRange.from < 0 ||
      structured.sourceRange.to < 0
    ) {
      throw new Error("checkpoint structured source range is invalid");
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
      structuredCheckpoint: Object.freeze({
        ...structured,
        sourceRange: Object.freeze({
          ...structured.sourceRange,
          kind: structured.sourceRange.kind ?? "LOCAL_HISTORY_INDEX",
        }),
      }),
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      modelRef: Object.freeze({ providerId: modelRef.providerId, modelId: modelRef.modelId }),
      createdAt: row.created_at_ms,
    });
  } catch (error) {
    if (error instanceof StorageDecodeError) throw error;
    throw new StorageDecodeError("ContextCheckpoint", row.id, "context_checkpoints", {
      cause: error,
    });
  }
}

function requireSafeNonNegative(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid`);
  }
}

function parseModelRef(value: unknown): { readonly providerId: string; readonly modelId: string } {
  const record = recordValue(value);
  const providerId = requiredText(record.providerId, "modelRef.providerId", 1_000, 1);
  const modelId = requiredText(record.modelId, "modelRef.modelId", 1_000, 1);
  if (!hasExactKeys(record, ["providerId", "modelId"])) throw new Error("modelRef is invalid");
  return { providerId, modelId };
}

function parseStructuredCheckpoint(value: unknown): StoredStructuredCheckpoint {
  const record = recordValue(value);
  const expectedKeys = [
    "version",
    "goal",
    "constraints",
    "completedWork",
    "inProgress",
    "blocked",
    "importantDiscoveries",
    "keyDecisions",
    "changedFiles",
    "readFiles",
    "recentErrors",
    "verificationState",
    "activeProcesses",
    "pendingApprovals",
    "resourceGovernance",
    "criticalReferences",
    "nextIntent",
    "sourceRange",
  ] as const;
  if (!hasExactKeys(record, expectedKeys) || record.version !== 1) {
    throw new Error("structured checkpoint is invalid");
  }
  return {
    version: 1,
    goal: requiredText(record.goal, "goal", 100_000, 1),
    constraints: stringList(record.constraints, "constraints"),
    completedWork: stringList(record.completedWork, "completedWork"),
    inProgress: stringList(record.inProgress, "inProgress"),
    blocked: stringList(record.blocked, "blocked"),
    importantDiscoveries: stringList(record.importantDiscoveries, "importantDiscoveries"),
    keyDecisions: stringList(record.keyDecisions, "keyDecisions"),
    changedFiles: stringList(record.changedFiles, "changedFiles"),
    readFiles: stringList(record.readFiles, "readFiles"),
    recentErrors: stringList(record.recentErrors, "recentErrors"),
    verificationState: requiredText(record.verificationState, "verificationState", 100_000),
    activeProcesses: stringList(record.activeProcesses, "activeProcesses"),
    pendingApprovals: stringList(record.pendingApprovals, "pendingApprovals"),
    resourceGovernance: requiredText(record.resourceGovernance, "resourceGovernance", 100_000),
    criticalReferences: stringList(record.criticalReferences, "criticalReferences"),
    nextIntent: requiredText(record.nextIntent, "nextIntent", 100_000),
    sourceRange: parseSourceRange(record.sourceRange),
  };
}

function parseSourceRange(value: unknown): StoredStructuredCheckpoint["sourceRange"] {
  const record = recordValue(value);
  if (!hasExactKeys(record, ["from", "to", ...(Object.hasOwn(record, "kind") ? ["kind"] : [])])) {
    throw new Error("sourceRange is invalid");
  }
  requireSafeNonNegative("sourceRange.from", record.from);
  requireSafeNonNegative("sourceRange.to", record.to);
  if (record.from > record.to) throw new Error("sourceRange is invalid");
  if (
    record.kind !== undefined &&
    record.kind !== "DURABLE_MESSAGE_SEQUENCE" &&
    record.kind !== "LOCAL_HISTORY_INDEX"
  ) {
    throw new Error("sourceRange.kind is invalid");
  }
  return {
    from: record.from,
    to: record.to,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
  };
}

function stringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${name} is invalid`);
  return value.map((item) => requiredText(item, name, 4_096));
}

function requiredText(value: unknown, name: string, maxBytes: number, minLength = 0): string {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
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
    if (existing !== undefined) {
      try {
        this.database.client
          .prepare(
            `UPDATE context_checkpoints
             SET previous_checkpoint_id = ?, tokens_before = ?, tokens_after = ?,
                 model_ref_json = ?, created_at_ms = ?, data_json = ?,
                 read_file_refs_json = ?, changed_file_refs_json = ?
             WHERE id = ?`,
          )
          .run(
            input.previousCheckpointId ?? null,
            input.tokensBefore,
            input.tokensAfter,
            JSON.stringify(input.modelRef),
            input.createdAt,
            JSON.stringify(input.structuredCheckpoint),
            JSON.stringify(input.structuredCheckpoint.readFiles),
            JSON.stringify(input.structuredCheckpoint.changedFiles),
            existing.id,
          );
      } catch (error) {
        throw new StorageError("Unable to refresh context checkpoint authority.", { cause: error });
      }
      const refreshed = this.database.client.prepare(`${SELECT} WHERE id = ?`).get(existing.id) as
        CheckpointRow | undefined;
      if (refreshed === undefined) throw new StorageError("Context checkpoint is unavailable.");
      return decode(refreshed);
    }
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

  async updateTokensAfter(checkpointId: string, tokensAfter: number): Promise<void> {
    if (!Number.isSafeInteger(tokensAfter) || tokensAfter < 0) {
      throw new StorageError("Context checkpoint token estimate is invalid.");
    }
    const result = this.database.client
      .prepare("UPDATE context_checkpoints SET tokens_after = ? WHERE id = ?")
      .run(tokensAfter, checkpointId);
    if (result.changes === 0) throw new StorageError("Context checkpoint is unavailable.");
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
