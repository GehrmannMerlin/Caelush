import {
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommitResult,
  type RunExecutionStorePort,
} from "@caelush/agent";
import { createHash } from "node:crypto";
import {
  assertRunExecutionInvariant,
  type RunCandidateBoundaryCommit,
  type RunCompletionPersistencePort,
  type RunExecutionCommitView,
  type RunExecutionSnapshotView,
  type RunVerifiedCompletionCommit,
} from "@caelush/core";
import type { AgentMessageRecord, AgentMessageRecordDraft } from "@caelush/agent";
import {
  AgentRunSchema,
  AgentStateSchema,
  AgentStepSchema,
  VerificationPlanSchema,
  VerifiedRunFinalResultSchema,
  type AgentState,
  type AgentStep,
  type RunId,
  type RunCancellationIntent,
  type VerificationPlan,
  type VerificationPlanId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { StorageConflictError, StorageError } from "./errors.js";
import { appendAgentMessageRecordsInTransaction } from "./messages/sqlite-agent-message-record-store.js";
import {
  clearContinuationInTransaction,
  setContinuationInTransaction,
} from "./repositories/continuation-repository.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { SqliteAgentMessageRecordStore } from "./messages/sqlite-agent-message-record-store.js";
import { SqliteContinuationRepository } from "./repositories/continuation-repository.js";
import { SqliteRunRepository } from "./repositories/run-repository.js";
import { SqliteRunStateRepository } from "./repositories/run-state-repository.js";
import { SqliteStepRepository } from "./repositories/step-repository.js";
import { writeStateSnapshot } from "./state-snapshot-writer.js";
import { SqliteCancellationRepository } from "./cancellation-repository.js";
import {
  loadVerificationPlanInTransaction,
  writeVerificationPlanInTransaction,
} from "./repositories/verification-repository.js";

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
  if (error instanceof StorageConflictError) {
    throw new RunExecutionConflictError("Run execution commit conflicted", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new RunExecutionConflictError("Run execution commit conflicted", { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError("Unable to commit Run execution", { cause: error });
}

function recordFromDraft(
  runId: RunId,
  sequence: number,
  draft: AgentMessageRecordDraft,
): AgentMessageRecord {
  return {
    messageId: draft.messageId,
    runId,
    sessionId: draft.sessionId,
    sequence,
    conversationTurnId: draft.conversationTurnId,
    messageType: draft.messageType,
    schemaVersion: draft.schemaVersion,
    ...(draft.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: draft.modelProjectionVersion }),
    ...(draft.sourceStepId === undefined ? {} : { sourceStepId: draft.sourceStepId }),
    createdAt: draft.createdAt,
    source: draft.source,
    audience: draft.audience,
    data: draft.data,
  };
}

function writeRun(client: CaelushDatabase["client"], run: RunExecutionCommitView["run"]): void {
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

export class SqliteRunExecutionStore
  implements RunExecutionStorePort, RunCompletionPersistencePort
{
  private readonly runs: SqliteRunRepository;
  private readonly states: SqliteRunStateRepository;
  private readonly steps: SqliteStepRepository;
  private readonly messageRecords: SqliteAgentMessageRecordStore;
  private readonly continuations: SqliteContinuationRepository;
  private readonly cancellations: SqliteCancellationRepository;

  constructor(private readonly database: CaelushDatabase) {
    this.runs = new SqliteRunRepository(database);
    this.states = new SqliteRunStateRepository(database);
    this.steps = new SqliteStepRepository(database);
    this.messageRecords = new SqliteAgentMessageRecordStore(database);
    this.continuations = new SqliteContinuationRepository(database);
    this.cancellations = new SqliteCancellationRepository(database);
  }

  async load(runId: RunId): Promise<RunExecutionSnapshotView | null> {
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
    const conversationRecords = await this.messageRecords.listByRun(runId);
    const loadedActiveStep =
      run.currentStepId === undefined ? undefined : await this.steps.get(run.currentStepId);
    // Phase 3E: a general Run snapshot carries no verification plan. The plan lives behind the
    // Core-private completion persistence port, which is the only boundary that reads it, and it is
    // written in the same transaction as the `VERIFYING` boundary that names it.
    const snapshot: RunExecutionSnapshotView = {
      run,
      ...stateProjection,
      ...(loadedActiveStep === undefined || loadedActiveStep === null
        ? {}
        : { activeStep: loadedActiveStep }),
      conversationRecords,
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
  ): Promise<RunExecutionSnapshotView> {
    if (intent.runId !== runId)
      throw new RunExecutionInvariantError("Cancellation Run ID mismatch");
    const snapshot = await this.load(runId);
    if (snapshot === null) throw new StorageError(`AgentRun ${runId} was not found`);
    await this.cancellations.request(intent);
    const latest = await this.load(runId);
    if (latest === null) throw new StorageError(`AgentRun ${runId} disappeared after cancellation`);
    return latest;
  }

  async commit(command: RunExecutionCommitView): Promise<RunExecutionCommitResult> {
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
      conversationRecords: [
        ...before.conversationRecords,
        ...command.messagesToAppend.map((entry, index) => ({
          ...recordFromDraft(
            command.run.id,
            before.conversationRecords.length + index + 1,
            entry.draft,
          ),
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
      appendAgentMessageRecordsInTransaction(
        client,
        command.run.id,
        command.messagesToAppend.map((entry) => entry.draft),
      );
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
      try {
        client.exec("ROLLBACK");
      } catch {
        throw new StorageError("Run execution commit failed after the transaction ended", {
          cause: error,
        });
      }
      mapExecutionError(error);
    }
  }

  async commitVerifiedCompletion(
    command: RunVerifiedCompletionCommit,
  ): Promise<RunExecutionCommitResult> {
    const parsedResult = VerifiedRunFinalResultSchema.parse(command.finalResult);
    const parsedRun = AgentRunSchema.parse({ ...command.run, finalResult: parsedResult });
    if (parsedRun.status !== "COMPLETED" || command.state.status !== "COMPLETED") {
      throw new RunExecutionInvariantError(
        "verified completion must settle Run and State to COMPLETED",
      );
    }
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.load(parsedRun.id);
      if (current === null) throw new StorageError(`AgentRun ${parsedRun.id} was not found`);
      // The plan is read from its own table now, not from the snapshot: Phase 3E closed the
      // compatibility view that used to smuggle it through a general Run. The identity check is
      // therefore against the durable row, which is the authority the completion was verified under.
      const durablePlan = loadVerificationPlanInTransaction(client, command.verificationPlan.id);
      if (
        current.run.status !== "VERIFYING" ||
        current.continuation?.type !== "AWAITING_VERIFICATION" ||
        current.continuation.verificationPlanId !== command.verificationPlan.id ||
        current.cancellationIntent !== undefined ||
        current.state === undefined ||
        durablePlan === null ||
        durablePlan.runId !== parsedRun.id ||
        durablePlan.sourceStepId !== current.continuation.sourceStepId ||
        durablePlan.planHash !== command.verificationPlan.planHash ||
        JSON.stringify(durablePlan) !== JSON.stringify(command.verificationPlan)
      ) {
        throw new RunExecutionConflictError("verified completion boundary is stale");
      }
      expectedRevision(current.stateRevision, command.expectedStateRevision, "AgentState");
      expectedRevision(
        current.continuationRevision,
        command.expectedContinuationRevision,
        "Continuation",
      );
      if (parsedRun.currentStepId !== undefined || command.state.currentStepId !== undefined) {
        throw new RunExecutionInvariantError("verified completion cannot retain an active Step");
      }
      assertRunExecutionInvariant({
        run: parsedRun,
        state: command.state,
        stateRevision: (current.stateRevision ?? 0) + 1,
        conversationRecords: current.conversationRecords,
      });
      writeRun(client, parsedRun);
      writeStateSnapshot(client, command.state, command.expectedStateRevision, (actual, expected) =>
        expectedRevision(actual, expected, "AgentState"),
      );
      clearContinuationInTransaction(client, parsedRun.id, command.expectedContinuationRevision);
      if (command.events.some((event) => event.runId !== parsedRun.id)) {
        throw new RunExecutionInvariantError("completion Event does not belong to the Run");
      }
      const events = appendDurableEventsInTransaction(client, command.events);
      client.exec("COMMIT");
      const snapshot = await this.load(parsedRun.id);
      if (snapshot === null) throw new StorageError("Run disappeared after completion");
      return { snapshot, events };
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new StorageError("verified completion rollback failed", { cause: rollbackError });
      }
      mapExecutionError(error);
    }
  }

  /**
   * Open a final candidate's verification boundary, atomically.
   *
   * ```text
   * AgentRun · AgentState · AgentStep · continuation · VerificationPlan · events
   * ```
   *
   * The plan and the Run boundary that points at it commit in **one** transaction. That is the whole
   * reason this is a separate entry point rather than a field on the general commit: a general Run
   * store has no vocabulary for a verification plan, and a boundary written without its plan — or a plan
   * written for a boundary that failed — would be a `VERIFYING` Run nobody can verify.
   *
   * The candidate hash is checked here, against the continuation the same transaction is writing, so a
   * plan bound to different text than the boundary records cannot become durable.
   */
  async commitCandidateBoundary(
    command: RunCandidateBoundaryCommit,
  ): Promise<RunExecutionCommitResult> {
    const plan = VerificationPlanSchema.parse(command.verificationPlan);
    const parsedRun = AgentRunSchema.parse(command.run);
    if (parsedRun.status !== "VERIFYING" || command.state.status !== "VERIFYING") {
      throw new RunExecutionInvariantError(
        "a candidate boundary must settle Run and State to VERIFYING",
      );
    }
    if (
      command.continuation.runId !== parsedRun.id ||
      command.continuation.verificationPlanId !== plan.id ||
      command.continuation.sourceStepId !== plan.sourceStepId ||
      plan.runId !== parsedRun.id
    ) {
      throw new RunExecutionInvariantError(
        "candidate boundary continuation does not match the VerificationPlan it names",
      );
    }
    // The candidate hash is recomputed here rather than imported from the verification package:
    // Storage must not depend on Verification, and the algorithm is one SHA-256 over the candidate
    // text — the same one `computeVerificationCandidateTextHash` performs. Reimplementing a hash is
    // normally exactly what a workspace should not do, so the byte definition is asserted against the
    // verification helper in Storage's own test suite rather than assumed here.
    const candidateHash = createHash("sha256")
      .update(command.continuation.finalDecision.candidateText, "utf8")
      .digest("hex");
    if (plan.candidateHash !== candidateHash) {
      throw new RunExecutionInvariantError(
        "VerificationPlan does not belong to the candidate this boundary records",
      );
    }
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.load(parsedRun.id);
      if (current === null) throw new StorageError(`AgentRun ${parsedRun.id} was not found`);
      if (current.run.status !== "RUNNING" || current.cancellationIntent !== undefined) {
        throw new RunExecutionConflictError("candidate boundary is stale");
      }
      expectedRevision(current.stateRevision, command.expectedStateRevision, "AgentState");
      expectedRevision(
        current.continuationRevision,
        command.expectedContinuationRevision,
        "Continuation",
      );
      if (parsedRun.currentStepId !== undefined || command.state.currentStepId !== undefined) {
        throw new RunExecutionInvariantError("a candidate boundary cannot retain an active Step");
      }
      assertRunExecutionInvariant({
        run: parsedRun,
        state: command.state,
        stateRevision: (current.stateRevision ?? 0) + 1,
        conversationRecords: current.conversationRecords,
        continuation: command.continuation,
        continuationRevision: (current.continuationRevision ?? 0) + 1,
      });
      if (command.events.some((event) => event.runId !== parsedRun.id)) {
        throw new RunExecutionInvariantError("boundary Event does not belong to the Run");
      }
      writeRun(client, parsedRun);
      writeStateSnapshot(client, command.state, command.expectedStateRevision, (actual, expected) =>
        expectedRevision(actual, expected, "AgentState"),
      );
      for (const stepWrite of command.stepWrites) {
        if (stepWrite.step.runId !== parsedRun.id) {
          throw new RunExecutionInvariantError("boundary Step does not belong to the Run");
        }
        writeStep(client, stepWrite.step, stepWrite.operation);
      }
      appendAgentMessageRecordsInTransaction(
        client,
        parsedRun.id,
        command.messagesToAppend.map((entry) => entry.draft),
      );
      setContinuationInTransaction(
        client,
        parsedRun.id,
        command.continuation,
        command.state.updatedAt,
        command.expectedContinuationRevision,
      );
      writeVerificationPlanInTransaction(client, plan);
      const events = appendDurableEventsInTransaction(client, command.events);
      client.exec("COMMIT");
      const snapshot = await this.load(parsedRun.id);
      if (snapshot === null) throw new StorageError("Run disappeared after opening its boundary");
      return { snapshot, events };
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new StorageError("candidate boundary rollback failed", { cause: rollbackError });
      }
      mapExecutionError(error);
    }
  }

  /**
   * The coding-completion half of the store.
   *
   * It is a separate contract because it answers questions only a coding Run asks: where its
   * verification plan is, and how a candidate boundary and a verified completion settle. The general
   * `RunExecutionStorePort` stays verification-agnostic, and a general Run store never has to implement
   * any of this.
   */
  async loadVerificationPlan(
    runId: RunId,
    planId: VerificationPlanId | undefined,
  ): Promise<VerificationPlan | null> {
    if (planId === undefined) {
      throw new RunExecutionInvariantError("VERIFYING Run has no VerificationPlan pointer");
    }
    const plan = loadVerificationPlanInTransaction(this.database.client, planId);
    if (plan === null) return null;
    if (plan.runId !== runId) {
      throw new RunExecutionInvariantError("VERIFYING Run has no matching VerificationPlan");
    }
    return plan;
  }
}
