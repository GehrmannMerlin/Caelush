import { AgentStateSchema, type AgentState, type RunId } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import { StorageDecodeError, StorageError } from "../errors.js";

interface StateRow {
  run_id: string;
  revision: number;
  updated_at_ms: number;
  data_json: string;
}

export interface RunStateRepository {
  get(runId: RunId): Promise<AgentState | null>;
  save(state: AgentState): Promise<{ state: AgentState; revision: number }>;
}

function decodeState(row: StateRow): AgentState {
  const state = decodeProtocol(AgentStateSchema, row.data_json, {
    entityType: "AgentState",
    entityId: row.run_id,
    table: "agent_state_snapshots",
  });

  if (state.runId !== row.run_id || state.updatedAt !== row.updated_at_ms || row.revision < 1) {
    throw new StorageDecodeError("AgentState", row.run_id, "agent_state_snapshots");
  }
  return state;
}

export class SqliteRunStateRepository implements RunStateRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(runId: RunId): Promise<AgentState | null> {
    const row = this.database.client
      .prepare(
        `SELECT run_id, revision, updated_at_ms, data_json
         FROM agent_state_snapshots WHERE run_id = ?`,
      )
      .get(runId) as StateRow | undefined;
    return row ? decodeState(row) : null;
  }

  async save(state: AgentState): Promise<{ state: AgentState; revision: number }> {
    const dataJson = encodeProtocol(AgentStateSchema, state, {
      entityType: "AgentState",
      entityId: state.runId,
      table: "agent_state_snapshots",
    });
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const existing = client
        .prepare("SELECT revision FROM agent_state_snapshots WHERE run_id = ?")
        .get(state.runId) as { revision: number } | undefined;
      const revision = existing ? existing.revision + 1 : 1;

      if (existing) {
        client
          .prepare(
            `UPDATE agent_state_snapshots SET revision = ?, updated_at_ms = ?, data_json = ?
             WHERE run_id = ?`,
          )
          .run(revision, state.updatedAt, dataJson, state.runId);
      } else {
        client
          .prepare(
            `INSERT INTO agent_state_snapshots (run_id, revision, updated_at_ms, data_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(state.runId, revision, state.updatedAt, dataJson);
      }

      client.exec("COMMIT");
      return { state, revision };
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Unable to save AgentState ${state.runId}`, { cause: error });
    }
  }
}
