import {
  createMemoryRecord,
  type MemoryCandidate,
  type MemoryRecord,
  type MemoryStore,
} from "@caelush/memory";
import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

interface MemoryRow {
  id: string;
  scope: string;
  project_id: string | null;
  topic: string;
  fact: string;
  status: string;
  confidence: number;
  evidence_refs_json: string;
  source_run_ids_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_confirmed_at_ms: number;
  supersedes: string | null;
  superseded_by: string | null;
  sensitivity: string;
  schema_version: number;
}

function decode(row: MemoryRow): MemoryRecord {
  return Object.freeze({
    id: row.id,
    scope: row.scope as MemoryRecord["scope"],
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    topic: row.topic,
    fact: row.fact,
    status: row.status as MemoryRecord["status"],
    confidence: row.confidence / 1_000_000,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    sourceRunIds: JSON.parse(row.source_run_ids_json) as string[],
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    lastConfirmedAt: row.last_confirmed_at_ms,
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    sensitivity: row.sensitivity as MemoryRecord["sensitivity"],
    schemaVersion: row.schema_version as 1,
  });
}

export class SqliteMemoryRepository implements MemoryStore {
  constructor(private readonly database: CaelushDatabase) {}

  async save(candidate: MemoryCandidate): Promise<MemoryRecord> {
    const record = createMemoryRecord(candidate, Date.now());
    try {
      this.database.client
        .prepare(
          `INSERT INTO memory_records
           (id, scope, project_id, topic, fact, status, confidence, evidence_refs_json,
            source_run_ids_json, created_at_ms, updated_at_ms, last_confirmed_at_ms,
            supersedes, superseded_by, sensitivity, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.scope,
          record.projectId ?? null,
          record.topic,
          record.fact,
          record.status,
          Math.round(record.confidence * 1_000_000),
          JSON.stringify(record.evidenceRefs),
          JSON.stringify(record.sourceRunIds ?? []),
          record.createdAt,
          record.updatedAt,
          record.lastConfirmedAt,
          record.supersedes ?? null,
          record.supersededBy ?? null,
          record.sensitivity,
          record.schemaVersion,
        );
    } catch (error) {
      throw new StorageError("Unable to persist memory record.", { cause: error });
    }
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const row = this.database.client
      .prepare("SELECT * FROM memory_records WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  async list(): Promise<readonly MemoryRecord[]> {
    const rows = this.database.client
      .prepare("SELECT * FROM memory_records ORDER BY updated_at_ms DESC, id ASC")
      .all() as unknown as MemoryRow[];
    return rows.map(decode);
  }

  async supersede(id: string, replacementId: string): Promise<void> {
    const replacement = await this.get(replacementId);
    if ((await this.get(id)) === undefined || replacement === undefined) {
      throw new StorageError("Memory record does not exist.");
    }
    const now = Date.now();
    this.database.client.exec("BEGIN IMMEDIATE");
    try {
      this.database.client
        .prepare(
          "UPDATE memory_records SET status = ?, superseded_by = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run("SUPERSEDED", replacementId, now, id);
      this.database.client
        .prepare("UPDATE memory_records SET supersedes = ?, updated_at_ms = ? WHERE id = ?")
        .run(id, now, replacementId);
      this.database.client.exec("COMMIT");
    } catch (error) {
      this.database.client.exec("ROLLBACK");
      throw new StorageError("Unable to supersede memory record.", { cause: error });
    }
  }

  async forget(id: string): Promise<void> {
    this.database.client.prepare("DELETE FROM memory_records WHERE id = ?").run(id);
  }
}
