import {
  AgentRunSchema,
  type AgentRun,
  type RunId,
  type RunStatus,
  type SessionId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";

interface RunRow {
  id: string;
  session_id: string;
  protocol_version: number;
  status: string;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  data_json: string;
}

export interface RunListOptions {
  readonly status?: RunStatus;
  readonly limit?: number;
}

export interface RunRepository {
  insert(run: AgentRun): Promise<void>;
  get(id: RunId): Promise<AgentRun | null>;
  update(run: AgentRun): Promise<void>;
  listBySession(sessionId: SessionId, options?: RunListOptions): Promise<AgentRun[]>;
}

function matchesOptional(actual: number | undefined, stored: number | null): boolean {
  return actual === undefined ? stored === null : actual === stored;
}

function decodeRun(row: RunRow): AgentRun {
  const run = decodeProtocol(AgentRunSchema, row.data_json, {
    entityType: "AgentRun",
    entityId: row.id,
    table: "agent_runs",
  });

  if (
    run.id !== row.id ||
    run.sessionId !== row.session_id ||
    run.status !== row.status ||
    run.createdAt !== row.created_at_ms ||
    !matchesOptional(run.startedAt, row.started_at_ms) ||
    !matchesOptional(run.finishedAt, row.finished_at_ms) ||
    row.protocol_version !== 1
  ) {
    throw new StorageDecodeError("AgentRun", row.id, "agent_runs");
  }

  return run;
}

function nullableTimestamp(value: number | undefined): number | null {
  return value ?? null;
}

function mapRepositoryError(error: unknown, action: string, id: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to ${action} AgentRun ${id}`, { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError(`Unable to ${action} AgentRun ${id}`, { cause: error });
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async insert(run: AgentRun): Promise<void> {
    const dataJson = encodeProtocol(AgentRunSchema, run, {
      entityType: "AgentRun",
      entityId: run.id,
      table: "agent_runs",
    });

    try {
      this.database.client
        .prepare(
          `INSERT INTO agent_runs
            (id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.sessionId,
          1,
          run.status,
          run.createdAt,
          nullableTimestamp(run.startedAt),
          nullableTimestamp(run.finishedAt),
          dataJson,
        );
    } catch (error) {
      mapRepositoryError(error, "insert", run.id);
    }
  }

  async get(id: RunId): Promise<AgentRun | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json
         FROM agent_runs WHERE id = ?`,
      )
      .get(id) as RunRow | undefined;
    return row ? decodeRun(row) : null;
  }

  async update(run: AgentRun): Promise<void> {
    const dataJson = encodeProtocol(AgentRunSchema, run, {
      entityType: "AgentRun",
      entityId: run.id,
      table: "agent_runs",
    });
    const result = this.database.client
      .prepare(
        `UPDATE agent_runs SET session_id = ?, protocol_version = ?, status = ?, created_at_ms = ?,
          started_at_ms = ?, finished_at_ms = ?, data_json = ? WHERE id = ?`,
      )
      .run(
        run.sessionId,
        1,
        run.status,
        run.createdAt,
        nullableTimestamp(run.startedAt),
        nullableTimestamp(run.finishedAt),
        dataJson,
        run.id,
      );

    if (result.changes === 0) {
      throw new StorageNotFoundError("AgentRun", run.id);
    }
  }

  async listBySession(sessionId: SessionId, options: RunListOptions = {}): Promise<AgentRun[]> {
    const params: Array<string | number> = [sessionId];
    let where = "session_id = ?";
    if (options.status !== undefined) {
      where += " AND status = ?";
      params.push(options.status);
    }
    let limit = "";
    if (options.limit !== undefined) {
      limit = " LIMIT ?";
      params.push(Math.max(0, Math.floor(options.limit)));
    }

    const rows = this.database.client
      .prepare(
        `SELECT id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json
         FROM agent_runs WHERE ${where} ORDER BY created_at_ms DESC, id ASC${limit}`,
      )
      .all(...params);
    return (rows as unknown as RunRow[]).map(decodeRun);
  }
}
