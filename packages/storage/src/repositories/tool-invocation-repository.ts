import {
  ToolInvocationSchema,
  type RunId,
  type StepId,
  type ToolInvocation,
  type ToolInvocationId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol } from "../codec.js";
import { StorageDecodeError } from "../errors.js";

interface ToolInvocationRow {
  id: string;
  run_id: string;
  step_id: string;
  external_call_id: string;
  tool_name: string;
  status: string;
  risk_level: string;
  revision: number;
  protocol_version: number;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  data_json: string;
}

export interface ToolInvocationRepository {
  get(id: ToolInvocationId): Promise<ToolInvocation | null>;
  findByExternalCall(
    runId: RunId,
    stepId: StepId,
    externalCallId: string,
  ): Promise<ToolInvocation | null>;
  listByRun(runId: RunId): Promise<readonly ToolInvocation[]>;
}

function matchesOptional(actual: number | undefined, stored: number | null): boolean {
  return actual === undefined ? stored === null : actual === stored;
}

export function decodeToolInvocation(row: ToolInvocationRow): ToolInvocation {
  const invocation = decodeProtocol(ToolInvocationSchema, row.data_json, {
    entityType: "ToolInvocation",
    entityId: row.id,
    table: "tool_invocations",
  });
  if (
    invocation.id !== row.id ||
    invocation.runId !== row.run_id ||
    invocation.stepId !== row.step_id ||
    invocation.externalCallId !== row.external_call_id ||
    invocation.toolName !== row.tool_name ||
    invocation.status !== row.status ||
    invocation.riskLevel !== row.risk_level ||
    invocation.createdAt !== row.created_at_ms ||
    !matchesOptional(invocation.startedAt, row.started_at_ms) ||
    !matchesOptional(invocation.finishedAt, row.finished_at_ms) ||
    row.protocol_version !== 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw new StorageDecodeError("ToolInvocation", row.id, "tool_invocations");
  }
  return invocation;
}

function selectInvocationRow(
  client: CaelushDatabase["client"],
  query: string,
  ...params: Array<string | number>
): ToolInvocationRow | undefined {
  return client.prepare(query).get(...params) as ToolInvocationRow | undefined;
}

export class SqliteToolInvocationRepository implements ToolInvocationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(id: ToolInvocationId): Promise<ToolInvocation | null> {
    const row = selectInvocationRow(
      this.database.client,
      `SELECT id, run_id, step_id, external_call_id, tool_name, status, risk_level, revision,
              protocol_version, created_at_ms, started_at_ms, finished_at_ms, data_json
       FROM tool_invocations WHERE id = ?`,
      id,
    );
    return row === undefined ? null : decodeToolInvocation(row);
  }

  async findByExternalCall(
    runId: RunId,
    stepId: StepId,
    externalCallId: string,
  ): Promise<ToolInvocation | null> {
    const row = selectInvocationRow(
      this.database.client,
      `SELECT id, run_id, step_id, external_call_id, tool_name, status, risk_level, revision,
              protocol_version, created_at_ms, started_at_ms, finished_at_ms, data_json
       FROM tool_invocations WHERE run_id = ? AND step_id = ? AND external_call_id = ?`,
      runId,
      stepId,
      externalCallId,
    );
    return row === undefined ? null : decodeToolInvocation(row);
  }

  async listByRun(runId: RunId): Promise<readonly ToolInvocation[]> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, step_id, external_call_id, tool_name, status, risk_level, revision,
                protocol_version, created_at_ms, started_at_ms, finished_at_ms, data_json
         FROM tool_invocations WHERE run_id = ? ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(runId);
    return (rows as unknown as ToolInvocationRow[]).map(decodeToolInvocation);
  }
}
