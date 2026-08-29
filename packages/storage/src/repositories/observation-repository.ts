import {
  ObservationSchema,
  ToolObservationSchema,
  type Observation,
  type ObservationId,
  type RunId,
  type ToolInvocationId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol } from "../codec.js";
import { StorageDecodeError } from "../errors.js";

interface ObservationRow {
  id: string;
  run_id: string;
  step_id: string;
  kind: string;
  tool_invocation_id: string | null;
  protocol_version: number;
  is_error: number;
  created_at_ms: number;
  data_json: string;
}

export interface ObservationRepository {
  get(id: ObservationId): Promise<Observation | null>;
  findByToolInvocation(
    invocationId: ToolInvocationId,
  ): Promise<Extract<Observation, { kind: "TOOL" }> | null>;
  listByRun(runId: RunId): Promise<readonly Observation[]>;
}

export function decodeObservation(row: ObservationRow): Observation {
  const observation = decodeProtocol(ObservationSchema, row.data_json, {
    entityType: "Observation",
    entityId: row.id,
    table: "agent_observations",
  });
  const toolInvocationId = observation.kind === "TOOL" ? observation.toolInvocationId : undefined;
  if (
    observation.id !== row.id ||
    observation.runId !== row.run_id ||
    observation.stepId !== row.step_id ||
    observation.kind !== row.kind ||
    (toolInvocationId ?? null) !== row.tool_invocation_id ||
    (observation.isError ? 1 : 0) !== row.is_error ||
    observation.createdAt !== row.created_at_ms ||
    row.protocol_version !== 1
  ) {
    throw new StorageDecodeError("Observation", row.id, "agent_observations");
  }
  return observation;
}

export class SqliteObservationRepository implements ObservationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(id: ObservationId): Promise<Observation | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, step_id, kind, tool_invocation_id, protocol_version,
                is_error, created_at_ms, data_json
         FROM agent_observations WHERE id = ?`,
      )
      .get(id) as ObservationRow | undefined;
    return row === undefined ? null : decodeObservation(row);
  }

  async findByToolInvocation(invocationId: ToolInvocationId) {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, step_id, kind, tool_invocation_id, protocol_version,
                is_error, created_at_ms, data_json
         FROM agent_observations WHERE tool_invocation_id = ?`,
      )
      .get(invocationId) as ObservationRow | undefined;
    if (row === undefined) return null;
    const observation = decodeObservation(row);
    if (observation.kind !== "TOOL") {
      throw new StorageDecodeError("ToolObservation", invocationId, "agent_observations");
    }
    return ToolObservationSchema.parse(observation);
  }

  async listByRun(runId: RunId): Promise<readonly Observation[]> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, step_id, kind, tool_invocation_id, protocol_version,
                is_error, created_at_ms, data_json
         FROM agent_observations WHERE run_id = ? ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(runId);
    return (rows as unknown as ObservationRow[]).map(decodeObservation);
  }
}
