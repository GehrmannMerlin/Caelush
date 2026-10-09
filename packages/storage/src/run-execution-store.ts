import {
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommitResult,
  type RunExecutionStorePort,
  deriveInterruptedToolResultMessageId,
} from "@caelush/agent";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SqlitePrivateReplayStore, PRIVATE_REPLAY_COMMIT } from "./private-replay-store.js";
import {
  assertRunExecutionInvariant,
  type RunCandidateBoundaryCommit,
  type RunCompletionPersistencePort,
  type RunExecutionCommitView,
  type RunExecutionSnapshotView,
  type RunVerifiedCompletionCommit,
} from "@caelush/core";
import type {
  AgentMessageRecord,
  AgentMessageRecordDraft,
  DurableRunEvent,
  DurableRunEventDraft,
  MissingToolInvocationEvidence,
} from "@caelush/agent";
import {
  CurrentAgentRunSchema,
  ObservationSchema,
  AgentStateSchema,
  AgentStepSchema,
  NormalRunFinalResultSchema,
  VerificationPlanSchema,
  VerifiedRunFinalResultSchema,
  type AgentState,
  type AgentStep,
  type RunId,
  type RunCancellationIntent,
  type VerificationPlan,
  type VerificationPlanId,
  type ToolInvocation,
  ToolInvocationSchema,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { StorageConflictError, StorageError } from "./errors.js";
import {
  appendAgentMessageRecordsInTransaction,
  listAgentMessageRecordsByRunInTransaction,
} from "./messages/sqlite-agent-message-record-store.js";
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

export type InterruptedHistoryClosureKind =
  "NOT_STARTED" | "OBSERVATION_COMMITTED" | "CANCELLED_CONFIRMED" | "OUTCOME_UNKNOWN";

export interface InterruptedHistoryClosureCommit {
  readonly sessionId: import("@caelush/protocol").SessionId;
  readonly runId: RunId;
  readonly expectedAssistant: AgentMessageRecord;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly batchToolCallIds: readonly string[];
  readonly callIndex: number;
  readonly closureVersion: number;
  readonly classification: InterruptedHistoryClosureKind;
  readonly missingInvocationEvidence: MissingToolInvocationEvidence;
  readonly message: AgentMessageRecordDraft;
  readonly messageEvent: DurableRunEventDraft;
}

export type InterruptedHistoryClosureCommitResult =
  | {
      readonly kind: "APPENDED";
      readonly message: AgentMessageRecord;
      readonly events: readonly DurableRunEvent[];
    }
  | {
      readonly kind: "ALREADY_PRESENT";
      readonly message: AgentMessageRecord;
      readonly events: readonly [];
    };

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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assistantCallIds(record: AgentMessageRecord): readonly string[] | undefined {
  const content = record.data["content"];
  if (!Array.isArray(content)) return undefined;
  const calls: string[] = [];
  for (const partValue of content) {
    const part = objectValue(partValue);
    if (part?.["type"] !== "TOOL_CALL") continue;
    if (typeof part["toolCallId"] !== "string" || typeof part["toolName"] !== "string") {
      return undefined;
    }
    calls.push(part["toolCallId"]);
  }
  return calls;
}

function hasToolCall(record: AgentMessageRecord, toolCallId: string, toolName: string): boolean {
  const content = record.data["content"];
  if (!Array.isArray(content)) return false;
  return content.some((partValue) => {
    const part = objectValue(partValue);
    return (
      part?.["type"] === "TOOL_CALL" &&
      part["toolCallId"] === toolCallId &&
      part["toolName"] === toolName
    );
  });
}

function toolResultCallId(record: AgentMessageRecord): string | undefined {
  if (record.messageType !== "TOOL_RESULT") return undefined;
  const value = record.data["toolCallId"];
  return typeof value === "string" ? value : undefined;
}

/** Refuse a NORMAL_COMPLETION unless its result, final message, Step and events agree. */
function assertNormalCompletionCommit(command: RunExecutionCommitView) {
  const raw = command.run.finalResult;
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    raw.type !== "NORMAL_COMPLETION"
  ) {
    return undefined;
  }
  const result = NormalRunFinalResultSchema.parse(raw);
  if (
    command.run.completionContract !== "NATURAL_V1" ||
    command.run.status !== "COMPLETED" ||
    command.run.currentStepId !== undefined ||
    command.state?.status !== "COMPLETED" ||
    command.state.verification !== "NOT_RUN" ||
    command.continuation?.operation === "SET"
  ) {
    throw new RunExecutionInvariantError("NORMAL_COMPLETION commit is missing its canonical state");
  }

  const settledSteps = command.stepWrites.filter(
    (write) => write.step.id === result.sourceStepId && write.step.runId === command.run.id,
  );
  if (settledSteps.length !== 1 || settledSteps[0]?.step.status !== "COMPLETED") {
    throw new RunExecutionInvariantError(
      "NORMAL_COMPLETION source Step must settle in the same Run transaction",
    );
  }

  const finalMessages = command.messagesToAppend
    .map(({ draft }) => draft)
    .filter((draft) => draft.messageType === "ASSISTANT" && draft.data.phase === "FINAL_ANSWER");
  if (
    command.messagesToAppend.length !== 1 ||
    finalMessages.length !== 1 ||
    finalMessages[0]?.sourceStepId !== result.sourceStepId
  ) {
    throw new RunExecutionInvariantError(
      "NORMAL_COMPLETION must append exactly one final Assistant message from its source Step",
    );
  }

  const content = finalMessages[0]!.data.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new RunExecutionInvariantError("NORMAL_COMPLETION final Assistant text is missing");
  }
  let finalText = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new RunExecutionInvariantError("NORMAL_COMPLETION final Assistant content is invalid");
    }
    const candidate = part as Record<string, unknown>;
    if (candidate.type !== "TEXT" || typeof candidate.text !== "string") {
      throw new RunExecutionInvariantError(
        "NORMAL_COMPLETION final Assistant content must contain only text",
      );
    }
    finalText += candidate.text;
  }
  if (finalText !== result.text) {
    throw new RunExecutionInvariantError(
      "NORMAL_COMPLETION text must match its durable final Assistant message",
    );
  }

  const messageId = finalMessages[0]!.messageId;
  const messageEventIndices = command.events.flatMap((event, index) =>
    event.type === "conversation.message.committed" && event.payload.messageId === messageId
      ? [index]
      : [],
  );
  const statusEventIndices = command.events.flatMap((event, index) =>
    event.type === "status.changed" &&
    event.payload.from === "RUNNING" &&
    event.payload.to === "COMPLETED"
      ? [index]
      : [],
  );
  const completedEventIndices = command.events.flatMap((event, index) =>
    event.type === "run.completed" && isDeepStrictEqual(event.payload.result, result)
      ? [index]
      : [],
  );
  if (
    messageEventIndices.length !== 1 ||
    statusEventIndices.length !== 1 ||
    completedEventIndices.length !== 1 ||
    !(
      messageEventIndices[0]! < statusEventIndices[0]! &&
      statusEventIndices[0]! < completedEventIndices[0]!
    )
  ) {
    throw new RunExecutionInvariantError(
      "NORMAL_COMPLETION message and terminal events must describe the same ordered commit",
    );
  }
  return result;
}

function writeRun(client: CaelushDatabase["client"], run: RunExecutionCommitView["run"]): void {
  const parsed = CurrentAgentRunSchema.parse(run);
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
      encodeProtocol(CurrentAgentRunSchema, parsed, {
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

  constructor(
    private readonly database: CaelushDatabase,
    private readonly privateReplay = new SqlitePrivateReplayStore(database),
  ) {
    this.runs = new SqliteRunRepository(database);
    this.states = new SqliteRunStateRepository(database);
    this.steps = new SqliteStepRepository(database);
    this.messageRecords = new SqliteAgentMessageRecordStore(database);
    this.continuations = new SqliteContinuationRepository(database);
    this.cancellations = new SqliteCancellationRepository(database);
  }

  /**
   * Append one Tool Result to an already CANCELLED Run without reopening its execution state.
   *
   * This is intentionally separate from the normal Run commit: it can append exactly one matching
   * TOOL_RESULT plus its metadata-only commit event, and it cannot write Run, State, Step,
   * Continuation, or Private Replay data.
   */
  async commitInterruptedHistoryClosure(
    command: InterruptedHistoryClosureCommit,
  ): Promise<InterruptedHistoryClosureCommitResult> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const runRow = client
        .prepare("SELECT id, session_id, status FROM agent_runs WHERE id = ?")
        .get(command.runId) as
        { readonly id: string; readonly session_id: string; readonly status: string } | undefined;
      if (
        runRow === undefined ||
        runRow.session_id !== command.sessionId ||
        runRow.status !== "CANCELLED"
      ) {
        throw new RunExecutionConflictError(
          "Interrupted history closure requires its cancelled Run.",
        );
      }

      const records = listAgentMessageRecordsByRunInTransaction(client, command.runId);
      const assistant = records.find(
        (record) => record.messageId === command.expectedAssistant.messageId,
      );
      if (
        assistant === undefined ||
        !isDeepStrictEqual(assistant, command.expectedAssistant) ||
        assistant.messageType !== "ASSISTANT" ||
        assistant.sessionId !== command.sessionId ||
        assistant.runId !== command.runId ||
        assistant.audience.model !== true ||
        assistant.sourceStepId === undefined ||
        assistant.sourceStepId !== command.message.sourceStepId ||
        assistant.conversationTurnId !== command.message.conversationTurnId
      ) {
        throw new RunExecutionInvariantError(
          "Interrupted Tool closure Assistant identity is invalid.",
        );
      }

      if (
        command.batchToolCallIds.length === 0 ||
        new Set(command.batchToolCallIds).size !== command.batchToolCallIds.length ||
        !Number.isSafeInteger(command.callIndex) ||
        command.callIndex < 0 ||
        command.callIndex >= command.batchToolCallIds.length ||
        command.batchToolCallIds[command.callIndex] !== command.toolCallId ||
        JSON.stringify(assistantCallIds(assistant)) !== JSON.stringify(command.batchToolCallIds) ||
        !hasToolCall(assistant, command.toolCallId, command.toolName)
      ) {
        throw new RunExecutionInvariantError(
          "Interrupted Tool closure does not match its Assistant call.",
        );
      }

      const sourceStep = client
        .prepare("SELECT run_id FROM agent_steps WHERE id = ?")
        .get(assistant.sourceStepId) as { readonly run_id: string } | undefined;
      if (sourceStep === undefined || sourceStep.run_id !== command.runId) {
        throw new RunExecutionInvariantError("Interrupted Tool closure Step identity is invalid.");
      }

      const expectedMessageId = deriveInterruptedToolResultMessageId({
        sessionId: command.sessionId,
        sourceRunId: command.runId,
        assistantMessageId: command.expectedAssistant.messageId,
        toolCallId: command.toolCallId,
        closureVersion: command.closureVersion,
      });
      const messageData = command.message.data;
      const observationRef = objectValue(messageData["observation"]);
      const projection = objectValue(messageData["projection"]);
      const policy = objectValue(projection?.["policy"]);
      if (
        command.message.messageId !== expectedMessageId ||
        command.message.sessionId !== command.sessionId ||
        command.message.messageType !== "TOOL_RESULT" ||
        command.message.audience.model !== true ||
        command.message.sourceStepId !== assistant.sourceStepId ||
        command.message.conversationTurnId !== assistant.conversationTurnId ||
        messageData["toolCallId"] !== command.toolCallId ||
        messageData["toolName"] !== command.toolName ||
        typeof messageData["projectedContent"] !== "string" ||
        typeof messageData["isError"] !== "boolean" ||
        policy?.["kind"] !== "SNAPSHOT" ||
        typeof projection?.["fingerprint"] !== "string" ||
        projection["version"] !== 1 ||
        (command.classification === "OBSERVATION_COMMITTED"
          ? observationRef?.["kind"] !== "OBSERVATION" ||
            typeof observationRef["observationId"] !== "string"
          : observationRef?.["kind"] !== "NO_OBSERVATION")
      ) {
        throw new RunExecutionInvariantError(
          "Interrupted Tool closure message contract is invalid.",
        );
      }

      if (
        command.messageEvent.type !== "conversation.message.committed" ||
        command.messageEvent.runId !== command.runId ||
        command.messageEvent.sessionId !== command.sessionId ||
        command.messageEvent.stepId !== undefined ||
        command.messageEvent.payload.messageId !== command.message.messageId ||
        command.messageEvent.payload.conversationTurnId !== assistant.conversationTurnId ||
        command.messageEvent.payload.messageType !== "TOOL_RESULT"
      ) {
        throw new RunExecutionInvariantError("Interrupted Tool closure event metadata is invalid.");
      }

      const matchingResults = records.filter(
        (record) => toolResultCallId(record) === command.toolCallId,
      );
      if (matchingResults.length > 1) {
        throw new RunExecutionConflictError(
          "Interrupted Tool call already has conflicting results.",
        );
      }
      const existingResult = matchingResults[0];
      if (existingResult !== undefined) {
        if (
          existingResult.sessionId !== command.sessionId ||
          existingResult.runId !== command.runId ||
          existingResult.conversationTurnId !== assistant.conversationTurnId ||
          existingResult.sourceStepId !== assistant.sourceStepId ||
          existingResult.audience.model !== true ||
          existingResult.data["toolName"] !== command.toolName
        ) {
          throw new RunExecutionConflictError(
            "Interrupted Tool call has a mismatched committed result.",
          );
        }
        if (
          existingResult.messageId === expectedMessageId &&
          !isDeepStrictEqual(
            existingResult,
            recordFromDraft(command.runId, existingResult.sequence, command.message),
          )
        ) {
          throw new RunExecutionConflictError(
            "Interrupted Tool closure retry has conflicting content.",
          );
        }
        client.exec("COMMIT");
        return { kind: "ALREADY_PRESENT", message: existingResult, events: [] };
      }

      const presentCallIds = new Set(
        records
          .filter((record) => record.messageType === "TOOL_RESULT")
          .map(toolResultCallId)
          .filter((value): value is string => value !== undefined),
      );
      for (let index = 0; index < command.batchToolCallIds.length; index += 1) {
        const present = presentCallIds.has(command.batchToolCallIds[index]!);
        if ((index < command.callIndex && !present) || (index > command.callIndex && present)) {
          throw new RunExecutionConflictError(
            "Interrupted Tool Result order cannot be repaired safely.",
          );
        }
      }

      const invocationRows = client
        .prepare(
          `SELECT id, run_id, step_id, external_call_id, data_json FROM tool_invocations
           WHERE run_id = ? AND step_id = ? AND external_call_id = ?`,
        )
        .all(command.runId, assistant.sourceStepId, command.toolCallId) as Array<{
        readonly id: string;
        readonly run_id: string;
        readonly step_id: string;
        readonly external_call_id: string;
        readonly data_json: string;
      }>;
      if (invocationRows.length > 1) {
        throw new RunExecutionInvariantError("Interrupted Tool execution identity is ambiguous.");
      }
      const invocationRow = invocationRows[0];
      let invocation: ToolInvocation | undefined;
      let observation: import("@caelush/protocol").ToolObservation | undefined;
      if (invocationRow !== undefined) {
        invocation = decodeProtocol(ToolInvocationSchema, invocationRow.data_json, {
          entityType: "ToolInvocation",
          entityId: invocationRow.id,
          table: "tool_invocations",
        });
        if (
          invocationRow.run_id !== command.runId ||
          invocationRow.step_id !== assistant.sourceStepId ||
          invocationRow.external_call_id !== command.toolCallId ||
          invocation.runId !== command.runId ||
          invocation.stepId !== assistant.sourceStepId ||
          invocation.externalCallId !== command.toolCallId ||
          invocation.toolName !== command.toolName
        ) {
          throw new RunExecutionInvariantError(
            "Interrupted Tool invocation facts do not match the call.",
          );
        }
        const observationRows = client
          .prepare(
            `SELECT id, run_id, step_id, kind, tool_invocation_id, data_json
             FROM agent_observations WHERE tool_invocation_id = ?`,
          )
          .all(invocation.id) as Array<{
          readonly id: string;
          readonly run_id: string;
          readonly step_id: string;
          readonly kind: string;
          readonly tool_invocation_id: string;
          readonly data_json: string;
        }>;
        if (observationRows.length > 1) {
          throw new RunExecutionInvariantError(
            "Interrupted Tool observation identity is ambiguous.",
          );
        }
        const observationRow = observationRows[0];
        if (observationRow !== undefined) {
          const parsed = decodeProtocol(ObservationSchema, observationRow.data_json, {
            entityType: "ToolObservation",
            entityId: observationRow.id,
            table: "agent_observations",
          });
          if (
            parsed.kind !== "TOOL" ||
            observationRow.kind !== "TOOL" ||
            observationRow.run_id !== command.runId ||
            observationRow.step_id !== assistant.sourceStepId ||
            observationRow.tool_invocation_id !== invocation.id ||
            parsed.runId !== command.runId ||
            parsed.stepId !== assistant.sourceStepId ||
            parsed.toolInvocationId !== invocation.id
          ) {
            throw new RunExecutionInvariantError(
              "Interrupted Tool observation facts do not match the call.",
            );
          }
          observation = parsed;
        }
      }

      switch (command.classification) {
        case "NOT_STARTED":
          if (
            observation !== undefined ||
            (invocation !== undefined &&
              invocation.status !== "REQUESTED" &&
              invocation.status !== "WAITING_APPROVAL") ||
            (invocation === undefined &&
              command.missingInvocationEvidence !== "DURABLE_STARTUP_CONTRACT_VERIFIED")
          ) {
            throw new RunExecutionConflictError(
              "Durable facts do not prove that this Tool never started.",
            );
          }
          break;
        case "OUTCOME_UNKNOWN":
          if (
            observation !== undefined ||
            (invocation === undefined
              ? command.missingInvocationEvidence !== "UNVERIFIED"
              : invocation.status !== "RUNNING")
          ) {
            throw new RunExecutionConflictError(
              "Durable facts no longer match the unknown Tool outcome.",
            );
          }
          break;
        case "CANCELLED_CONFIRMED":
          if (invocation?.status !== "CANCELLED" || observation !== undefined) {
            throw new RunExecutionConflictError(
              "Durable facts do not confirm this Tool cancellation.",
            );
          }
          break;
        case "OBSERVATION_COMMITTED":
          if (
            invocation === undefined ||
            observation === undefined ||
            (invocation.status !== "COMPLETED" &&
              invocation.status !== "FAILED" &&
              invocation.status !== "CANCELLED") ||
            observation.id !== observationRef?.["observationId"] ||
            messageData["isError"] !== observation.isError
          ) {
            throw new RunExecutionConflictError(
              "Durable Tool observation cannot back this message.",
            );
          }
          break;
      }

      const appended = appendAgentMessageRecordsInTransaction(client, command.runId, [
        command.message,
      ]);
      const events = appendDurableEventsInTransaction(client, [command.messageEvent]);
      client.exec("COMMIT");
      const message = appended[0];
      if (message === undefined) {
        throw new StorageError("Interrupted Tool Result was not appended.");
      }
      return { kind: "APPENDED", message, events };
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch {
        throw new StorageError("Interrupted history closure failed after the transaction ended.", {
          cause: error,
        });
      }
      mapExecutionError(error);
    }
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
    const normalFinalResult = assertNormalCompletionCommit(command);
    const privateReplayWrites = await this.privateReplay.validateWrites(
      command.privateReplayWrites ?? [],
    );
    const before = await this.load(command.run.id);
    if (before === null) throw new StorageError(`AgentRun ${command.run.id} was not found`);
    const replayIds = new Set(privateReplayWrites.map((write) => write.identity.messageId));
    // Only exact retries of replay-backed messages may reuse a durable message identity.
    const messagesToAppend = command.messagesToAppend.filter(({ draft }) => {
      const existing = before.conversationRecords.find(
        (record) => record.messageId === draft.messageId,
      );
      if (existing === undefined || !replayIds.has(draft.messageId)) return true;
      if (!isDeepStrictEqual(existing, recordFromDraft(command.run.id, existing.sequence, draft))) {
        throw new RunExecutionConflictError("Private replay message retry conflicted.");
      }
      return false;
    });
    command = { ...command, messagesToAppend };
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
      if (normalFinalResult !== undefined) {
        // Re-read after acquiring SQLite's write lock. Cancellation committed first wins; otherwise
        // this is the one terminal writer for the persisted natural-completion boundary.
        const current = await this.load(command.run.id);
        if (
          current === null ||
          current.run.status !== "RUNNING" ||
          current.run.completionContract !== "NATURAL_V1" ||
          current.run.sessionId !== command.run.sessionId ||
          current.run.workspace.id !== command.run.workspace.id ||
          current.run.workspace.path !== command.run.workspace.path ||
          current.cancellationIntent !== undefined ||
          current.activeStep?.id !== normalFinalResult.sourceStepId ||
          (current.continuation !== undefined &&
            (command.continuation?.operation !== "CLEAR" ||
              current.continuation.type !== "WAITING_TOOL_RESULTS" ||
              current.continuation.waitingApproval !== undefined ||
              current.continuation.receivedResults === undefined)) ||
          current.conversationRecords.some(
            (record) => record.messageType === "ASSISTANT" && record.data.phase === "FINAL_ANSWER",
          )
        ) {
          throw new RunExecutionConflictError("natural completion boundary is stale");
        }
      }
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
        PRIVATE_REPLAY_COMMIT,
      );
      this.privateReplay.writeInTransaction(
        command.run.id,
        privateReplayWrites,
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
    const parsedRun = CurrentAgentRunSchema.parse({ ...command.run, finalResult: parsedResult });
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
        current.run.completionContract === "NATURAL_V1" ||
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
    const privateReplayWrites = await this.privateReplay.validateWrites(
      command.privateReplayWrites ?? [],
    );
    const plan = VerificationPlanSchema.parse(command.verificationPlan);
    const parsedRun = CurrentAgentRunSchema.parse(command.run);
    if (
      parsedRun.status !== "VERIFYING" ||
      command.state.status !== "VERIFYING" ||
      parsedRun.completionContract === "NATURAL_V1"
    ) {
      throw new RunExecutionInvariantError(
        "a legacy candidate boundary must settle an unmarked Run and State to VERIFYING",
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
        PRIVATE_REPLAY_COMMIT,
      );
      this.privateReplay.writeInTransaction(
        parsedRun.id,
        privateReplayWrites,
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
