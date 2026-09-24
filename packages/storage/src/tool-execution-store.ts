import {
  AgentRunSchema,
  AgentStateSchema,
  AgentStepSchema,
  ObservationSchema,
  ToolInvocationSchema,
  ToolObservationSchema,
  type SessionId,
  type ToolInvocation,
  type ToolObservation,
  type TimestampMs,
} from "@caelush/protocol";
import {
  assertToolInvocationInvariant,
  assertToolObservationInvariant,
  ToolExecutionConflictError,
  ToolExecutionInvariantError,
  type DurableToolEventDraft,
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "@caelush/agent";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { StorageError } from "./errors.js";
import { SqliteObservationRepository } from "./repositories/observation-repository.js";
import { SqliteToolInvocationRepository } from "./repositories/tool-invocation-repository.js";
import { writeStateSnapshot } from "./state-snapshot-writer.js";
import {
  SqliteApprovalRepository,
  writeApprovalInTransaction,
} from "./repositories/approval-repository.js";
import {
  ToolSettlementExtensionError,
  type ToolSettlementExtensionDecoder,
} from "./tool-settlement-extension-adapter.js";

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
  if (error instanceof ToolSettlementExtensionError) {
    // A settlement the host could not interpret is a fail-closed rollback. It is reported as an
    // invariant failure so the caller does not mistake it for a retryable conflict: the transaction
    // rolled back, and re-running the same commit would fail the same way.
    throw new ToolExecutionInvariantError(error.message, { cause: error });
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

/**
 * Move the matching Tool budget reservation to `IN_FLIGHT`, inside the RUNNING commit.
 *
 * ```text
 * REQUESTED
 *   ↓ budget.admit  → RESERVED
 * RUNNING commit    → IN_FLIGHT        ← this function, same transaction
 * ```
 *
 * The atomicity is the point: a crash between "the invocation is RUNNING" and "the budget started"
 * would leave durable truth that budget recovery has to guess about. Doing both in one transaction
 * removes the gap rather than narrowing it.
 *
 * An absent row is not an error: a host that enforces no Tool budget simply has no ledger entry, and a
 * `budgetStart` hint with nothing to move is a no-op.
 */
function startBudgetInTransaction(
  client: CaelushDatabase["client"],
  runId: string,
  ownerId: string,
  startedAt: number,
): void {
  const result = client
    .prepare(
      `UPDATE run_budget_entries
       SET state = 'IN_FLIGHT', started_at_ms = ?
       WHERE run_id = ? AND kind = 'TOOL_INVOCATION' AND owner_id = ? AND state = 'RESERVED'`,
    )
    .run(startedAt, runId, ownerId);
  if (result.changes === 0) return;
  if (result.changes !== 1) {
    throw new ToolExecutionInvariantError("Tool budget reservation is ambiguous.");
  }
}

/**
 * Finish the matching Tool budget entry, inside the terminal commit.
 *
 * ```text
 * IN_FLIGHT   → SETTLED        a Tool that ran to a final answer
 * IN_FLIGHT   → CONSERVATIVE   an execution whose side effect is uncertain
 * RESERVED    → RELEASED       a handler that provably never started
 * absent                      this host enforces no Tool budget
 * already terminal            idempotent no-op
 * ```
 *
 * ## Why conservative is not settled
 *
 * An `UNCERTAIN_SIDE_EFFECT` invocation may have performed external work that cannot be measured. Its
 * reservation is real consumption as far as accounting is concerned, so the entry becomes
 * `CONSERVATIVE` — the same state Run budget recovery uses for an ambiguous in-flight entry. Settling it
 * as if it had completed cleanly would understate what the Run consumed and would disagree with what
 * recovery concludes about the same row.
 *
 * ## Why this closes the terminal crash gap
 *
 * Before Phase 4C the terminal commit and the budget settlement were two calls, and a crash between
 * them left a terminal Tool invocation beside an `IN_FLIGHT` reservation. The frozen
 * `ToolExecutionCommit` has no settlement field, so the fix is not a new field: the store recognizes
 * the invocation's own terminal state and finishes the matching entry in the same transaction. The
 * coordinator's later `ToolBudgetAdmissionPort.settle(...)` is then an idempotent restatement of a fact
 * that is already durable.
 */
function settleBudgetInTransaction(
  client: CaelushDatabase["client"],
  runId: string,
  ownerId: string,
  invocation: ToolInvocation,
): void {
  const row = client
    .prepare(
      `SELECT state FROM run_budget_entries
       WHERE run_id = ? AND kind = 'TOOL_INVOCATION' AND owner_id = ?`,
    )
    .get(runId, ownerId) as { state: string } | undefined;
  if (row === undefined) return;
  if (row.state === "SETTLED" || row.state === "CONSERVATIVE" || row.state === "RELEASED") return;
  const settledAt = invocation.finishedAt ?? invocation.createdAt;
  if (row.state === "IN_FLIGHT") {
    const terminal = isUncertainExecution(invocation) ? "CONSERVATIVE" : "SETTLED";
    const columns =
      terminal === "SETTLED"
        ? ", actual_input_tokens = 0, actual_output_tokens = 0, actual_cost_micros = 0"
        : "";
    const result = client
      .prepare(
        `UPDATE run_budget_entries SET state = ?${columns}, settled_at_ms = ?
         WHERE run_id = ? AND kind = 'TOOL_INVOCATION' AND owner_id = ? AND state = 'IN_FLIGHT'`,
      )
      .run(terminal, settledAt, runId, ownerId);
    if (result.changes !== 1) {
      throw new ToolExecutionInvariantError("Tool budget settlement lost its entry.");
    }
    return;
  }
  if (row.state === "RESERVED") {
    // The handler provably never started — a policy denial, an approval rejection, a budget block, a
    // pre-execution abort. The reservation is released rather than consumed.
    const result = client
      .prepare(
        `UPDATE run_budget_entries SET state = 'RELEASED', settled_at_ms = ?
         WHERE run_id = ? AND kind = 'TOOL_INVOCATION' AND owner_id = ? AND state = 'RESERVED'`,
      )
      .run(settledAt, runId, ownerId);
    if (result.changes !== 1) {
      throw new ToolExecutionInvariantError("Tool budget release lost its entry.");
    }
  }
}

/**
 * Did this invocation end with an unverifiable side effect?
 *
 * The answer is read from the durable error the invocation carries — `executionDisposition =
 * UNCERTAIN_SIDE_EFFECT` — never from an in-memory flag, so a recovery that re-settles the same row
 * reaches the same budget conclusion.
 */
function isUncertainExecution(invocation: ToolInvocation): boolean {
  return (
    invocation.status !== "COMPLETED" &&
    invocation.error?.details?.executionDisposition === "UNCERTAIN_SIDE_EFFECT"
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

/** Options a store needs beyond its database. */
export interface SqliteToolExecutionStoreOptions {
  /**
   * The host's Tool settlement extension decoder.
   *
   * It is the compatibility boundary that turns the canonical opaque extension back into the host's own
   * effect vocabulary, and it is injected so `@caelush/storage` never imports a Coding effect type.
   * Absent means this host projects nothing: an extension that arrives with no decoder is refused rather
   * than ignored, because a Tool must never be recorded `COMPLETED` while effects are unaccounted for.
   */
  readonly settlementExtension?: ToolSettlementExtensionDecoder | undefined;
}

export class SqliteToolExecutionStore implements ToolExecutionStorePort {
  private readonly invocations: SqliteToolInvocationRepository;
  private readonly observations: SqliteObservationRepository;
  private readonly approvals: SqliteApprovalRepository;
  private readonly settlementExtension: ToolSettlementExtensionDecoder | undefined;

  constructor(
    private readonly database: CaelushDatabase,
    options: SqliteToolExecutionStoreOptions = {},
  ) {
    this.invocations = new SqliteToolInvocationRepository(database);
    this.observations = new SqliteObservationRepository(database);
    this.approvals = new SqliteApprovalRepository(database);
    this.settlementExtension = options.settlementExtension;
  }

  async load(
    invocationId: ToolExecutionCommit["invocation"]["id"],
  ): Promise<ToolExecutionSnapshot | null> {
    const invocation = await this.invocations.get(invocationId);
    if (invocation === null) return null;
    const observation = await this.observations.findByToolInvocation(invocationId);
    const approval = await this.approvals.getByInvocation(invocationId);
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
      if (invocation.status !== "CANCELLED") {
        throw new ToolExecutionInvariantError(
          "Terminal ToolInvocation is missing its observation.",
        );
      }
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
      ...(approval === null ? {} : { approval }),
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
    if (command.approval !== undefined && command.approvalKey === undefined) {
      throw new ToolExecutionInvariantError("Approval creation requires an internal approval key.");
    }
    if (
      command.approval !== undefined &&
      (command.approval.toolInvocationId !== command.invocation.id ||
        command.approval.runId !== command.invocation.runId ||
        command.approval.status !== "PENDING")
    ) {
      throw new ToolExecutionInvariantError(
        "Approval creation does not match the waiting ToolInvocation.",
      );
    }
    validateEvents(
      command.events,
      command.invocation.runId,
      command.sessionId,
      command.invocation.stepId,
    );
    // The extension is decoded *before* the transaction opens, so an extension this host cannot
    // interpret is refused without ever having taken a write lock.
    const hostEffects = this.decodeExtension(command.extension);
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
      if (command.budgetStart !== undefined) {
        if (command.budgetStart.ownerId !== command.invocation.id) {
          throw new ToolExecutionInvariantError("Tool budget owner does not match the invocation.");
        }
        startBudgetInTransaction(
          client,
          command.invocation.runId,
          command.budgetStart.ownerId,
          command.budgetStart.startedAt,
        );
      }
      if (command.approval !== undefined) {
        writeApprovalInTransaction(client, command.approval, command.approvalKey!);
      }
      if (command.observation !== undefined) writeObservation(client, command.observation);
      if (hostEffects !== undefined && hostEffects.changeState) {
        const stateRow = client
          .prepare("SELECT revision, data_json FROM agent_state_snapshots WHERE run_id = ?")
          .get(command.invocation.runId) as { revision: number; data_json: string } | undefined;
        if (stateRow === undefined) {
          throw new ToolExecutionInvariantError("Tool effects require an AgentState snapshot.");
        }
        const state = decodeProtocol(AgentStateSchema, stateRow.data_json, {
          entityType: "AgentState",
          entityId: command.invocation.runId,
          table: "agent_state_snapshots",
        });
        const updated = hostEffects.apply(
          state,
          Math.max(
            state.updatedAt,
            command.invocation.finishedAt ?? command.invocation.createdAt,
          ) as TimestampMs,
        );
        writeStateSnapshot(client, updated, stateRow.revision, (actual, expected) => {
          if (actual !== expected) {
            throw new ToolExecutionConflictError(
              "AgentState revision changed during Tool execution.",
            );
          }
        });
      }
      if (command.invocation.finishedAt !== undefined) {
        settleBudgetInTransaction(
          client,
          command.invocation.runId,
          command.invocation.id,
          command.invocation,
        );
      }
      const events = appendDurableEventsInTransaction(client, command.events);
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

  private decodeExtension(
    extension: ToolExecutionCommit["extension"],
  ): ReturnType<ToolSettlementExtensionDecoder["decode"]> {
    if (extension === undefined) return undefined;
    if (this.settlementExtension === undefined) {
      throw new ToolSettlementExtensionError(
        "Tool settlement carried an extension this host cannot decode.",
      );
    }
    return this.settlementExtension.decode(extension);
  }
}
