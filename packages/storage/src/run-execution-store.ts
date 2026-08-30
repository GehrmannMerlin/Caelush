import {
  assertRunExecutionInvariant,
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommit,
  type RunExecutionCommitResult,
  type RunExecutionSnapshot,
  type RunExecutionStorePort,
} from "@caelush/core";
import {
  AgentRunSchema,
  AgentStateSchema,
  AgentStepSchema,
  type AgentState,
  type AgentStep,
  type RunId,
  type RunCancellationIntent,
} from "@caelush/protocol";
import { DuplicateEventError } from "@caelush/events";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { StorageConflictError, StorageError } from "./errors.js";
import { appendConversationMessagesInTransaction } from "./repositories/conversation-repository.js";
import {
  clearContinuationInTransaction,
  setContinuationInTransaction,
} from "./repositories/continuation-repository.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { SqliteConversationRepository } from "./repositories/conversation-repository.js";
import { SqliteContinuationRepository } from "./repositories/continuation-repository.js";
import { SqliteRunRepository } from "./repositories/run-repository.js";
import { SqliteRunStateRepository } from "./repositories/run-state-repository.js";
import { SqliteStepRepository } from "./repositories/step-repository.js";
import { writeStateSnapshot } from "./state-snapshot-writer.js";
import { SqliteCancellationRepository } from "./cancellation-repository.js";

interface StateRow {
  run_id: string;
  revision: number;
  updated_at_ms: number;
  data_json: string;
}

function decodeState(row: StateRow): AgentState {
  return decodeProtocol(AgentStateSchema, row.data_json, {
    entityType: "AgentState",
    entityId: row.run_id,
    table: "agent_state_snapshots",
  });
}

function expectedRevision(
  actual: number | undefined,
  expected: number | null,
  label: string,
): void {
  const normalized = actual ?? null;
  if (normalized !== expected) {
    throw new RunExecutionConflictError(
      `${label} revision conflict: expected ${String(expected)}, actual ${String(normalized)}`,
    );
  }
}

function mapExecutionError(error: unknown): never {
  if (error instanceof RunExecutionConflictError || error instanceof RunExecutionInvariantError) {
    throw error;
  }
  if (error instanceof StorageConflictError || error instanceof DuplicateEventError) {
    throw new RunExecutionConflictError("Run execution commit conflicted", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new RunExecutionConflictError("Run execution commit conflicted", { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError("Unable to commit Run execution", { cause: error });
}

function writeRun(client: CaelushDatabase["client"], run: RunExecutionCommit["run"]): void {
  const parsed = AgentRunSchema.parse(run);
  const result = client
    .prepare(
      `UPDATE agent_runs SET session_id = ?, protocol_version = ?, status = ?, created_at_ms = ?,
        started_at_ms = ?, finished_at_ms = ?, data_json = ? WHERE id = ?`,
    )
    .run(
      parsed.sessionId,
      1,
      parsed.status,
      parsed.createdAt,
      parsed.startedAt ?? null,
      parsed.finishedAt ?? null,
      encodeProtocol(AgentRunSchema, parsed, {
        entityType: "AgentRun",
        entityId: parsed.id,
        table: "agent_runs",
      }),
      parsed.id,
    );
  if (result.changes === 0) throw new StorageError(`AgentRun ${parsed.id} was not found`);
}

function writeStep(
  client: CaelushDatabase["client"],
  step: AgentStep,
  operation: "INSERT" | "UPDATE",
): void {
  const parsed = AgentStepSchema.parse(step);
  const dataJson = encodeProtocol(AgentStepSchema, parsed, {
    entityType: "AgentStep",
    entityId: parsed.id,
    table: "agent_steps",
  });
  if (operation === "INSERT") {
    client
      .prepare(
        `INSERT INTO agent_steps
         (id, run_id, sequence, status, started_at_ms, finished_at_ms, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.sequence,
        parsed.status,
        parsed.startedAt,
        parsed.finishedAt ?? null,
        dataJson,
      );
    return;
  }
  const result = client
    .prepare(
      `UPDATE agent_steps SET run_id = ?, sequence = ?, status = ?, started_at_ms = ?,
       finished_at_ms = ?, data_json = ? WHERE id = ?`,
    )
    .run(
      parsed.runId,
      parsed.sequence,
      parsed.status,
      parsed.startedAt,
      parsed.finishedAt ?? null,
      dataJson,
      parsed.id,
    );
  if (result.changes === 0) throw new StorageError(`AgentStep ${parsed.id} was not found`);
}

export class SqliteRunExecutionStore implements RunExecutionStorePort {
  private readonly runs: SqliteRunRepository;
  private readonly states: SqliteRunStateRepository;
  private readonly steps: SqliteStepRepository;
  private readonly messages: SqliteConversationRepository;
  private readonly continuations: SqliteContinuationRepository;
  private readonly cancellations: SqliteCancellationRepository;

  constructor(private readonly database: CaelushDatabase) {
    this.runs = new SqliteRunRepository(database);
    this.states = new SqliteRunStateRepository(database);
    this.steps = new SqliteStepRepository(database);
    this.messages = new SqliteConversationRepository(database);
    this.continuations = new SqliteContinuationRepository(database);
    this.cancellations = new SqliteCancellationRepository(database);
  }

  async load(runId: RunId): Promise<RunExecutionSnapshot | null> {
    const run = await this.runs.get(runId);
    if (run === null) return null;
    const stateRow = this.database.client
      .prepare(
        `SELECT run_id, revision, updated_at_ms, data_json
         FROM agent_state_snapshots WHERE run_id = ?`,
      )
      .get(runId) as StateRow | undefined;
    const state = stateRow === undefined ? undefined : decodeState(stateRow);
    const stateProjection =
      stateRow === undefined
        ? {}
        : { state: state as AgentState, stateRevision: stateRow.revision };
    const continuation = await this.continuations.get(runId);
    const cancellationIntent = await this.cancellations.get(runId);
    const conversation = await this.messages.listByRun(runId);
    const loadedActiveStep =
      run.currentStepId === undefined ? undefined : await this.steps.get(run.currentStepId);
    const snapshot: RunExecutionSnapshot = {
      run,
      ...stateProjection,
      ...(loadedActiveStep === undefined || loadedActiveStep === null
        ? {}
        : { activeStep: loadedActiveStep }),
      conversation,
      ...(continuation === undefined || continuation === null
        ? {}
        : { continuation: continuation.checkpoint, continuationRevision: continuation.revision }),
      ...(cancellationIntent === null ? {} : { cancellationIntent }),
    };
    assertRunExecutionInvariant(snapshot);
    return snapshot;
  }

  async requestCancellation(
    runId: RunId,
    intent: RunCancellationIntent,
  ): Promise<RunExecutionSnapshot> {
    if (intent.runId !== runId)
      throw new RunExecutionInvariantError("Cancellation Run ID mismatch");
    const snapshot = await this.load(runId);
    if (snapshot === null) throw new StorageError(`AgentRun ${runId} was not found`);
    await this.cancellations.request(intent);
    const latest = await this.load(runId);
    if (latest === null) throw new StorageError(`AgentRun ${runId} disappeared after cancellation`);
    return latest;
  }

  async commit(command: RunExecutionCommit): Promise<RunExecutionCommitResult> {
    const before = await this.load(command.run.id);
    if (before === null) throw new StorageError(`AgentRun ${command.run.id} was not found`);
    const candidateContinuation =
      command.continuation?.operation === "SET"
        ? {
            continuation: command.continuation.checkpoint,
            continuationRevision: (before.continuationRevision ?? 0) + 1,
          }
        : command.continuation?.operation === "CLEAR"
          ? {}
          : before.continuation === undefined
            ? {}
            : before.continuationRevision === undefined
              ? { continuation: before.continuation }
              : {
                  continuation: before.continuation,
                  continuationRevision: before.continuationRevision,
                };
    const candidateStep = command.stepWrites.find((write) => write.step.status === "RUNNING")?.step;
    assertRunExecutionInvariant({
      run: command.run,
      ...(command.state === undefined
        ? before.state === undefined
          ? {}
          : { state: before.state, stateRevision: before.stateRevision }
        : { state: command.state, stateRevision: (before.stateRevision ?? 0) + 1 }),
      ...(command.run.currentStepId === undefined
        ? {}
        : candidateStep === undefined
          ? before.activeStep === undefined
            ? {}
            : { activeStep: before.activeStep }
          : { activeStep: candidateStep }),
      conversation: [
        ...before.conversation,
        ...command.messagesToAppend.map((entry, index) => ({
          runId: command.run.id,
          sequence: before.conversation.length + index + 1,
          ...entry,
        })),
      ],
      ...candidateContinuation,
    });
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      writeRun(client, command.run);
      if (command.state !== undefined)
        writeStateSnapshot(
          client,
          command.state,
          command.expectedStateRevision,
          (actual, expected) => expectedRevision(actual, expected, "AgentState"),
        );
      for (const stepWrite of command.stepWrites) {
        if (stepWrite.step.runId !== command.run.id) {
          throw new RunExecutionInvariantError("execution Step does not belong to the Run");
        }
        writeStep(client, stepWrite.step, stepWrite.operation);
      }
      if (command.events.some((event) => event.runId !== command.run.id)) {
        throw new RunExecutionInvariantError("execution Event does not belong to the Run");
      }
      appendConversationMessagesInTransaction(client, command.run.id, command.messagesToAppend);
      if (command.continuation?.operation === "SET") {
        setContinuationInTransaction(
          client,
          command.run.id,
          command.continuation.checkpoint,
          command.continuation.updatedAt,
          command.expectedContinuationRevision,
        );
      } else if (command.continuation?.operation === "CLEAR") {
        clearContinuationInTransaction(
          client,
          command.run.id,
          command.expectedContinuationRevision,
        );
      }
      const events = appendDurableEventsInTransaction(client, command.events);
      client.exec("COMMIT");
      const snapshot = await this.load(command.run.id);
      if (snapshot === null)
        throw new StorageError(`Run ${command.run.id} disappeared after commit`);
      return { snapshot, events };
    } catch (error) {
      client.exec("ROLLBACK");
      mapExecutionError(error);
    }
  }
}
