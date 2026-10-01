import {
  CurrentAgentRunSchema,
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

/**
 * The non-terminal statuses a fresh daemon may still have work to reconcile.
 *
 * ```text
 * RUNNING            a Run whose driver died with the previous process; a stale Step or an
 *                    unreported boundary has to be settled
 * VERIFYING          a Run that died during completion evaluation
 * WAITING_APPROVAL   a Run parked on an approval; recovery restores the *same* wait and never
 *                    approves on the user's behalf
 * WAITING_RESOURCE   a Run parked on a resource decision; recovery restores the same wait
 * ```
 *
 * `PENDING` is deliberately absent. A pending Run has never started, so there is nothing to
 * reconcile: starting it is a user action, not a recovery, and a daemon that auto-started it would
 * be executing work the user never launched.
 */
export const RECOVERABLE_RUN_STATUSES = Object.freeze([
  "RUNNING",
  "VERIFYING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
] as const satisfies readonly RunStatus[]);

/**
 * How many recoverable Runs one reconciliation pass reads.
 *
 * The bound is what stops a daemon start from walking an unbounded history, and the value is
 * generous enough that a realistic backlog is drained in one pass while a pathological one is
 * bounded, ordered and deterministic rather than accidentally skipped.
 */
export const RECOVERABLE_RUN_DEFAULT_LIMIT = 100;

export interface RecoverableRunQuery {
  /** The non-terminal statuses to consider; defaults to `RECOVERABLE_RUN_STATUSES`. */
  readonly statuses?: readonly RunStatus[];
  /** The maximum number of Runs to return; defaults to `RECOVERABLE_RUN_DEFAULT_LIMIT`. */
  readonly limit?: number;
}

export interface RunRepository {
  insert(run: AgentRun): Promise<void>;
  get(id: RunId): Promise<AgentRun | null>;
  update(run: AgentRun): Promise<void>;
  listBySession(sessionId: SessionId, options?: RunListOptions): Promise<AgentRun[]>;
  /**
   * Enumerate the Runs a fresh daemon generation must reconcile.
   *
   * Ordered oldest-first and then by id, so a backlog is drained in arrival order and two identical
   * database states always answer the same list. It is a *query*, not a decision: which of these
   * Runs may actually be recovered — and the fact that a terminal Run may never be reopened — is
   * the supervisor's and the RunController's authority, not this repository's.
   */
  listRecoverable(options?: RecoverableRunQuery): Promise<AgentRun[]>;
}

function matchesOptional(actual: number | undefined, stored: number | null): boolean {
  return actual === undefined ? stored === null : actual === stored;
}

function decodeRun(row: RunRow): AgentRun {
  const run = decodeProtocol(CurrentAgentRunSchema, row.data_json, {
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
    const currentRun = CurrentAgentRunSchema.parse(run);
    const dataJson = encodeProtocol(CurrentAgentRunSchema, currentRun, {
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
          currentRun.id,
          currentRun.sessionId,
          1,
          currentRun.status,
          currentRun.createdAt,
          nullableTimestamp(currentRun.startedAt),
          nullableTimestamp(currentRun.finishedAt),
          dataJson,
        );
    } catch (error) {
      mapRepositoryError(error, "insert", run.id);
    }
  }

  async get(id: RunId): Promise<AgentRun | null> {
    try {
      const row = this.database.client
        .prepare(
          `SELECT id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json
           FROM agent_runs WHERE id = ?`,
        )
        .get(id) as RunRow | undefined;
      return row ? decodeRun(row) : null;
    } catch (error) {
      // The read paths are wrapped exactly like the write paths. An unwrapped driver failure — a
      // handle that is no longer open, for instance — used to escape as an untyped error and be
      // answered as an anonymous internal error, which is the one outcome an operator cannot act on.
      mapRepositoryError(error, "get", id);
    }
  }

  async update(run: AgentRun): Promise<void> {
    const currentRun = CurrentAgentRunSchema.parse(run);
    const dataJson = encodeProtocol(CurrentAgentRunSchema, currentRun, {
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
        currentRun.sessionId,
        1,
        currentRun.status,
        currentRun.createdAt,
        nullableTimestamp(currentRun.startedAt),
        nullableTimestamp(currentRun.finishedAt),
        dataJson,
        currentRun.id,
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

    try {
      const rows = this.database.client
        .prepare(
          `SELECT id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json
           FROM agent_runs WHERE ${where} ORDER BY created_at_ms DESC, id ASC${limit}`,
        )
        .all(...params);
      return (rows as unknown as RunRow[]).map(decodeRun);
    } catch (error) {
      mapRepositoryError(error, "list", sessionId);
    }
  }

  async listRecoverable(options: RecoverableRunQuery = {}): Promise<AgentRun[]> {
    const statuses = options.statuses ?? RECOVERABLE_RUN_STATUSES;
    if (statuses.length === 0) return [];
    const limit = Math.max(0, Math.floor(options.limit ?? RECOVERABLE_RUN_DEFAULT_LIMIT));
    if (limit === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    try {
      const rows = this.database.client
        .prepare(
          `SELECT id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json
           FROM agent_runs WHERE status IN (${placeholders})
           ORDER BY created_at_ms ASC, id ASC LIMIT ?`,
        )
        .all(...statuses, limit);
      return (rows as unknown as RunRow[]).map(decodeRun);
    } catch (error) {
      mapRepositoryError(error, "listRecoverable", "recoverable");
    }
  }
}
