import { AgentStepSchema, type AgentStep, type RunId, type StepId } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";

interface StepRow {
  id: string;
  run_id: string;
  sequence: number;
  status: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  data_json: string;
}

export interface StepRepository {
  insert(step: AgentStep): Promise<void>;
  get(id: StepId): Promise<AgentStep | null>;
  update(step: AgentStep): Promise<void>;
  listByRun(runId: RunId): Promise<AgentStep[]>;
}

function decodeStep(row: StepRow): AgentStep {
  const step = decodeProtocol(AgentStepSchema, row.data_json, {
    entityType: "AgentStep",
    entityId: row.id,
    table: "agent_steps",
  });

  const finishedAtMatches =
    step.finishedAt === undefined
      ? row.finished_at_ms === null
      : step.finishedAt === row.finished_at_ms;
  if (
    step.id !== row.id ||
    step.runId !== row.run_id ||
    step.sequence !== row.sequence ||
    step.status !== row.status ||
    step.startedAt !== row.started_at_ms ||
    !finishedAtMatches
  ) {
    throw new StorageDecodeError("AgentStep", row.id, "agent_steps");
  }

  return step;
}

function mapRepositoryError(error: unknown, action: string, id: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to ${action} AgentStep ${id}`, { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError(`Unable to ${action} AgentStep ${id}`, { cause: error });
}

export class SqliteStepRepository implements StepRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async insert(step: AgentStep): Promise<void> {
    const dataJson = encodeProtocol(AgentStepSchema, step, {
      entityType: "AgentStep",
      entityId: step.id,
      table: "agent_steps",
    });

    try {
      this.database.client
        .prepare(
          `INSERT INTO agent_steps
            (id, run_id, sequence, status, started_at_ms, finished_at_ms, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          step.id,
          step.runId,
          step.sequence,
          step.status,
          step.startedAt,
          step.finishedAt ?? null,
          dataJson,
        );
    } catch (error) {
      mapRepositoryError(error, "insert", step.id);
    }
  }

  async get(id: StepId): Promise<AgentStep | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, sequence, status, started_at_ms, finished_at_ms, data_json
         FROM agent_steps WHERE id = ?`,
      )
      .get(id) as StepRow | undefined;
    return row ? decodeStep(row) : null;
  }

  async update(step: AgentStep): Promise<void> {
    const dataJson = encodeProtocol(AgentStepSchema, step, {
      entityType: "AgentStep",
      entityId: step.id,
      table: "agent_steps",
    });
    const result = this.database.client
      .prepare(
        `UPDATE agent_steps SET run_id = ?, sequence = ?, status = ?, started_at_ms = ?,
          finished_at_ms = ?, data_json = ? WHERE id = ?`,
      )
      .run(
        step.runId,
        step.sequence,
        step.status,
        step.startedAt,
        step.finishedAt ?? null,
        dataJson,
        step.id,
      );
    if (result.changes === 0) {
      throw new StorageNotFoundError("AgentStep", step.id);
    }
  }

  async listByRun(runId: RunId): Promise<AgentStep[]> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, sequence, status, started_at_ms, finished_at_ms, data_json
         FROM agent_steps WHERE run_id = ? ORDER BY sequence ASC`,
      )
      .all(runId);
    return (rows as unknown as StepRow[]).map(decodeStep);
  }
}
