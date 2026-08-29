import {
  AgentRunSchema,
  AgentStepSchema,
  ObservationSchema,
  ToolInvocationSchema,
  ToolObservationSchema,
  type SessionId,
  type ToolInvocation,
  type ToolObservation,
} from "@caelush/protocol";
import { DuplicateEventError, type DurableEventDraft } from "@caelush/events";
import {
  assertToolInvocationInvariant,
  assertToolObservationInvariant,
  type DurableToolEventDraft,
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
  ToolExecutionConflictError,
  ToolExecutionInvariantError,
} from "@caelush/tools";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { StorageError } from "./errors.js";
import { SqliteObservationRepository } from "./repositories/observation-repository.js";
import { SqliteToolInvocationRepository } from "./repositories/tool-invocation-repository.js";

function expectedRevision(actual: number | undefined, expected: number | null): void {
  const normalized = actual ?? null;
  if (normalized !== expected) {
    throw new ToolExecutionConflictError(
      `Tool invocation revision conflict: expected ${String(expected)}, actual ${String(normalized)}`,
    );
  }
}

function mapStoreError(error: unknown): never {
  if (error instanceof ToolExecutionConflictError || error instanceof ToolExecutionInvariantError) {
    throw error;
  }
  if (error instanceof DuplicateEventError) {
    throw new ToolExecutionConflictError(
      "Tool execution event conflicts with existing durable data.",
      {
        cause: error,
      },
    );
  }
  if (error instanceof StorageError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new ToolExecutionConflictError(
      "Tool execution durable data conflicts with existing data.",
      {
        cause: error,
      },
    );
  }
  throw new StorageError("Unable to commit Tool execution", { cause: error });
}

function validateRunAndStep(
  client: CaelushDatabase["client"],
  sessionId: SessionId,
  runId: string,
  stepId: string,
): void {
  const runRow = client
    .prepare("SELECT id, session_id, status, data_json FROM agent_runs WHERE id = ?")
    .get(runId) as
    { id: string; session_id: string; status: string; data_json: string } | undefined;
  if (runRow === undefined)
    throw new ToolExecutionInvariantError("Tool execution Run does not exist.");
  const run = decodeProtocol(AgentRunSchema, runRow.data_json, {
    entityType: "AgentRun",
    entityId: runId,
    table: "agent_runs",
  });
  if (run.sessionId !== sessionId || runRow.session_id !== sessionId) {
    throw new ToolExecutionInvariantError("Tool execution session does not match the Run.");
  }
  if (run.status !== "RUNNING" || runRow.status !== "RUNNING") {
    throw new ToolExecutionInvariantError("Tool execution requires a RUNNING Run.");
  }

  const stepRow = client
    .prepare("SELECT id, run_id, status, data_json FROM agent_steps WHERE id = ?")
    .get(stepId) as { id: string; run_id: string; status: string; data_json: string } | undefined;
  if (stepRow === undefined)
    throw new ToolExecutionInvariantError("Tool execution source Step does not exist.");
  const step = decodeProtocol(AgentStepSchema, stepRow.data_json, {
    entityType: "AgentStep",
    entityId: stepId,
    table: "agent_steps",
  });
  if (step.runId !== runId || stepRow.run_id !== runId) {
    throw new ToolExecutionInvariantError("Tool execution source Step does not belong to the Run.");
  }
  if (step.status !== "COMPLETED" || stepRow.status !== "COMPLETED") {
    throw new ToolExecutionInvariantError("Tool execution requires a COMPLETED source Step.");
  }
}

function writeInvocation(
  client: CaelushDatabase["client"],
  invocation: ToolInvocation,
  revision: number,
): void {
  const parsed = ToolInvocationSchema.parse(invocation);
  if (parsed.externalCallId === undefined) {
    throw new ToolExecutionInvariantError(
      "Tool invocation externalCallId is required for persistence.",
    );
  }
  const dataJson = encodeProtocol(ToolInvocationSchema, parsed, {
    entityType: "ToolInvocation",
    entityId: parsed.id,
    table: "tool_invocations",
  });
  client
    .prepare(
      `INSERT INTO tool_invocations
       (id, run_id, step_id, external_call_id, tool_name, status, risk_level, revision,
        protocol_version, created_at_ms, started_at_ms, finished_at_ms, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
       ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id, step_id = excluded.step_id,
        external_call_id = excluded.external_call_id, tool_name = excluded.tool_name,
        status = excluded.status, risk_level = excluded.risk_level, revision = excluded.revision,
        protocol_version = excluded.protocol_version, created_at_ms = excluded.created_at_ms,
        started_at_ms = excluded.started_at_ms, finished_at_ms = excluded.finished_at_ms,
        data_json = excluded.data_json`,
    )
    .run(
      parsed.id,
      parsed.runId,
      parsed.stepId,
      parsed.externalCallId,
      parsed.toolName,
      parsed.status,
      parsed.riskLevel,
      revision,
      1,
      parsed.createdAt,
      parsed.startedAt ?? null,
      parsed.finishedAt ?? null,
      dataJson,
    );
}

function writeObservation(client: CaelushDatabase["client"], observation: ToolObservation): void {
  const parsed = ToolObservationSchema.parse(observation);
  const dataJson = encodeProtocol(ObservationSchema, parsed, {
    entityType: "ToolObservation",
    entityId: parsed.id,
    table: "agent_observations",
  });
  client
    .prepare(
      `INSERT INTO agent_observations
       (id, run_id, step_id, kind, tool_invocation_id, protocol_version, is_error, created_at_ms, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.id,
      parsed.runId,
      parsed.stepId,
      parsed.kind,
      parsed.toolInvocationId,
      1,
      parsed.isError ? 1 : 0,
      parsed.createdAt,
      dataJson,
    );
}

function validateEvents(
  events: readonly DurableToolEventDraft[],
  runId: string,
  sessionId: SessionId,
  stepId: string,
): void {
  for (const event of events) {
    if (event.runId !== runId || event.sessionId !== sessionId || event.stepId !== stepId) {
      throw new ToolExecutionInvariantError(
        "Tool execution event does not belong to its invocation.",
      );
    }
  }
}

export class SqliteToolExecutionStore implements ToolExecutionStorePort {
  private readonly invocations: SqliteToolInvocationRepository;
  private readonly observations: SqliteObservationRepository;

  constructor(private readonly database: CaelushDatabase) {
    this.invocations = new SqliteToolInvocationRepository(database);
    this.observations = new SqliteObservationRepository(database);
  }

  async load(
    invocationId: ToolExecutionCommit["invocation"]["id"],
  ): Promise<ToolExecutionSnapshot | null> {
    const invocation = await this.invocations.get(invocationId);
    if (invocation === null) return null;
    const observation = await this.observations.findByToolInvocation(invocationId);
    assertToolInvocationInvariant(invocation);
    if (
      invocation.status === "REQUESTED" ||
      invocation.status === "WAITING_APPROVAL" ||
      invocation.status === "RUNNING"
    ) {
      if (observation !== null) {
        throw new ToolExecutionInvariantError("Non-terminal ToolInvocation has an observation.");
      }
    } else if (observation === null) {
      throw new ToolExecutionInvariantError("Terminal ToolInvocation is missing its observation.");
    } else {
      assertToolObservationInvariant(observation, invocation);
    }
    const row = this.database.client
      .prepare(
        `SELECT tool_invocations.revision, agent_runs.session_id
         FROM tool_invocations JOIN agent_runs ON agent_runs.id = tool_invocations.run_id
         WHERE tool_invocations.id = ?`,
      )
      .get(String(invocationId)) as { revision: number; session_id: string } | undefined;
    if (row === undefined) return null;
    return {
      sessionId: row.session_id as ToolExecutionSnapshot["sessionId"],
      invocation,
      revision: row.revision,
      ...(observation === null ? {} : { observation }),
    };
  }

  async findByExternalCall(
    runId: ToolExecutionCommit["invocation"]["runId"],
    stepId: ToolExecutionCommit["invocation"]["stepId"],
    externalCallId: string,
  ): Promise<ToolExecutionSnapshot | null> {
    const invocation = await this.invocations.findByExternalCall(runId, stepId, externalCallId);
    return invocation === null ? null : this.load(invocation.id);
  }

  async commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult> {
    assertToolInvocationInvariant(command.invocation);
    if (command.observation !== undefined) {
      assertToolObservationInvariant(command.observation, command.invocation);
    }
    validateEvents(
      command.events,
      command.invocation.runId,
      command.sessionId,
      command.invocation.stepId,
    );
    const client = this.database.client;
    let committedEvents: ToolExecutionCommitResult["events"];
    client.exec("BEGIN IMMEDIATE");
    try {
      validateRunAndStep(
        client,
        command.sessionId,
        command.invocation.runId,
        command.invocation.stepId,
      );
      const existing = client
        .prepare("SELECT revision FROM tool_invocations WHERE id = ?")
        .get(command.invocation.id) as { revision: number } | undefined;
      expectedRevision(existing?.revision, command.expectedRevision);
      const revision = (existing?.revision ?? 0) + 1;
      writeInvocation(client, command.invocation, revision);
      if (command.observation !== undefined) writeObservation(client, command.observation);
      const events = appendDurableEventsInTransaction(
        client,
        command.events as unknown as readonly DurableEventDraft[],
      );
      client.exec("COMMIT");
      committedEvents = events as unknown as ToolExecutionCommitResult["events"];
    } catch (error) {
      client.exec("ROLLBACK");
      mapStoreError(error);
    }
    const snapshot = await this.load(command.invocation.id);
    if (snapshot === null) throw new StorageError("Tool invocation disappeared after commit.");
    return { snapshot, events: committedEvents };
  }
}
