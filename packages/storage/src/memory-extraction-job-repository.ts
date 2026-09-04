import {
  createMemoryExtractionJob,
  type MemoryExtractionJob,
  type MemoryExtractionJobCreateInput,
  type MemoryExtractionJobStore,
} from "@caelush/memory";
import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

interface JobRow {
  id: string;
  source_run_id: string;
  project_id: string;
  status: string;
  attempt: number;
  created_at_ms: number;
  updated_at_ms: number;
  last_error: string | null;
}

function decode(row: JobRow): MemoryExtractionJob {
  return Object.freeze({
    id: row.id,
    sourceRunId: row.source_run_id,
    projectId: row.project_id,
    status: row.status as MemoryExtractionJob["status"],
    attempt: row.attempt,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  });
}

export class SqliteMemoryExtractionJobRepository implements MemoryExtractionJobStore {
  constructor(private readonly database: CaelushDatabase) {}

  async createOrGet(input: MemoryExtractionJobCreateInput): Promise<MemoryExtractionJob> {
    const existing = this.database.client
      .prepare("SELECT * FROM memory_extraction_jobs WHERE source_run_id = ?")
      .get(input.sourceRunId) as JobRow | undefined;
    if (existing !== undefined) return decode(existing);
    const job = createMemoryExtractionJob(input);
    try {
      this.database.client
        .prepare(
          `INSERT INTO memory_extraction_jobs
           (id, source_run_id, project_id, status, attempt, created_at_ms, updated_at_ms, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.sourceRunId,
          job.projectId,
          job.status,
          job.attempt,
          job.createdAt,
          job.updatedAt,
          null,
        );
    } catch (error) {
      throw new StorageError("Unable to persist memory extraction job.", { cause: error });
    }
    return job;
  }

  async get(id: string): Promise<MemoryExtractionJob | undefined> {
    const row = this.database.client
      .prepare("SELECT * FROM memory_extraction_jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  async listPending(): Promise<readonly MemoryExtractionJob[]> {
    const rows = this.database.client
      .prepare(
        "SELECT * FROM memory_extraction_jobs WHERE status = 'PENDING' ORDER BY created_at_ms ASC, id ASC",
      )
      .all() as unknown as JobRow[];
    return rows.map(decode);
  }

  async claim(id: string, now: number): Promise<MemoryExtractionJob | undefined> {
    return this.transition(id, "PENDING", "RUNNING", now);
  }

  async complete(id: string, now: number): Promise<MemoryExtractionJob | undefined> {
    return this.transition(id, "RUNNING", "COMPLETED", now);
  }

  async fail(id: string, now: number, message: string): Promise<MemoryExtractionJob | undefined> {
    const result = this.database.client
      .prepare(
        "UPDATE memory_extraction_jobs SET status = 'FAILED', updated_at_ms = ?, last_error = ?, attempt = attempt + 1 WHERE id = ? AND status = 'RUNNING'",
      )
      .run(now, message.slice(0, 512), id);
    return result.changes === 0 ? undefined : this.get(id);
  }

  private async transition(
    id: string,
    expected: "PENDING" | "RUNNING",
    next: "RUNNING" | "COMPLETED",
    now: number,
  ): Promise<MemoryExtractionJob | undefined> {
    const result = this.database.client
      .prepare(
        "UPDATE memory_extraction_jobs SET status = ?, updated_at_ms = ?, attempt = attempt + ? WHERE id = ? AND status = ?",
      )
      .run(next, now, next === "RUNNING" ? 1 : 0, id, expected);
    return result.changes === 0 ? undefined : this.get(id);
  }
}
