import {
  AttachmentSha256Schema,
  AgentRunSchema,
  CurrentAgentRunSchema,
  PreparedInputResourceReceiptV1Schema,
  RunWorkflowExecutionProfileV1Schema,
  SubmissionIdSchema,
  WorkflowArtifactRefSchema,
  WorkflowResourceBindingDraftV1Schema,
  WorkflowResourceBindingV1Schema,
  type AgentRun,
  type RunId,
  type PreparedInputResourceReceiptV1,
  type RunStatus,
  type SessionId,
  type SubmissionRecord,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingDraftV1,
  type WorkflowResourceBindingV1,
  type WorkflowArtifactRef,
} from "@caelush/protocol";
import { randomUUID } from "node:crypto";
import type { CaelushDatabase } from "../database.js";
import {
  assertArchiveWritableInTransaction,
  withArchiveWriteTransaction,
} from "../archive/archive-write-guard.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";
import type { DurableRunEvent, DurableRunEventDraft } from "@caelush/agent";
import { appendDurableEventsInTransaction } from "../events/sqlite-durable-event-store.js";
import { bindSubmissionRunInTransaction } from "../submission-repository.js";
import {
  decodePreparedResourceRecord,
  decodeWorkflowExecutionProfile,
  encodePreparedResourceRecord,
  encodeWorkflowExecutionProfile,
} from "../prepared-resource-records.js";

export type RunSubmissionIdentity = Pick<SubmissionRecord, "submissionId" | "payloadHash">;

export interface InsertRunWithPreparedResourcesInput {
  readonly run: AgentRun;
  readonly workflowProfile?: RunWorkflowExecutionProfileV1;
  readonly resourcesInOrder: readonly WorkflowResourceBindingDraftV1[];
  readonly events: readonly DurableRunEventDraft[];
  readonly submissionIdentity?: RunSubmissionIdentity;
}

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
  /** Atomically persist a fresh Run and its creation-bound durable event drafts. */
  insertWithEvents?(
    run: AgentRun,
    events: readonly DurableRunEventDraft[],
  ): Promise<readonly DurableRunEvent[]>;
  insertRunWithPreparedResources?(
    input: InsertRunWithPreparedResourcesInput,
  ): Promise<readonly DurableRunEvent[]>;
  readPreparedResources?(runId: RunId): Promise<readonly WorkflowResourceBindingV1[]>;
  readPreparedInputReceipts?(runId: RunId): Promise<readonly PreparedInputResourceReceiptV1[]>;
  readWorkflowProfile?(runId: RunId): Promise<RunWorkflowExecutionProfileV1 | null>;
  /** Read-only artifact liveness across generic Run workflow profiles and bindings. */
  isWorkflowArtifactReferenced?(artifactRef: WorkflowArtifactRef): Promise<boolean>;
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
  const run = decodeProtocol(AgentRunSchema, row.data_json, {
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
    withArchiveWriteTransaction(this.database, () => {
      assertArchiveWritableInTransaction(this.database, {
        type: "SESSION",
        sessionId: run.sessionId,
      });
      assertArchiveWritableInTransaction(this.database, {
        type: "WORKSPACE",
        workspaceId: run.workspace.id,
      });
      this.insertInTransaction(run);
      if (run.submissionId !== undefined) {
        bindSubmissionRunInTransaction(this.database, run.submissionId, run.id);
      }
    });
  }

  private insertInTransaction(run: AgentRun): void {
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

  async insertWithEvents(
    run: AgentRun,
    events: readonly DurableRunEventDraft[],
  ): Promise<readonly DurableRunEvent[]> {
    const currentRun = CurrentAgentRunSchema.parse(run);
    const dataJson = encodeProtocol(CurrentAgentRunSchema, currentRun, {
      entityType: "AgentRun",
      entityId: run.id,
      table: "agent_runs",
    });
    if (events.some((event) => event.runId !== run.id)) {
      throw new StorageError(`Unable to insert AgentRun ${run.id}: event belongs to another Run`);
    }

    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      assertArchiveWritableInTransaction(this.database, {
        type: "SESSION",
        sessionId: run.sessionId,
      });
      assertArchiveWritableInTransaction(this.database, {
        type: "WORKSPACE",
        workspaceId: run.workspace.id,
      });
      client
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
      if (run.submissionId !== undefined) {
        bindSubmissionRunInTransaction(this.database, run.submissionId, run.id);
      }
      const committed = appendDurableEventsInTransaction(client, events);
      client.exec("COMMIT");
      return committed;
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch {
        throw new StorageError(`Unable to insert AgentRun ${run.id} after transaction failure`, {
          cause: error,
        });
      }
      mapRepositoryError(error, "insert", run.id);
    }
  }

  async insertRunWithPreparedResources(
    input: InsertRunWithPreparedResourcesInput,
  ): Promise<readonly DurableRunEvent[]> {
    const currentRun = CurrentAgentRunSchema.parse(input.run);
    const workflowProfile =
      input.workflowProfile === undefined
        ? undefined
        : RunWorkflowExecutionProfileV1Schema.parse(input.workflowProfile);
    if (workflowProfile !== undefined && workflowProfile.runId !== currentRun.id) {
      throw new StorageError(
        "Unable to insert AgentRun " + currentRun.id + ": workflow profile belongs to another Run",
      );
    }
    const resources = input.resourcesInOrder.map((draft) =>
      WorkflowResourceBindingDraftV1Schema.parse(draft),
    );
    if (
      resources.some((resource) => resource.runId !== currentRun.id) ||
      (resources.length > 0 && workflowProfile === undefined)
    ) {
      throw new StorageError(
        "Unable to insert AgentRun " + currentRun.id + ": prepared resource identity is invalid",
      );
    }
    if (input.events.some((event) => event.runId !== currentRun.id)) {
      throw new StorageError(
        "Unable to insert AgentRun " + currentRun.id + ": event belongs to another Run",
      );
    }

    const submissionIdentity =
      input.submissionIdentity === undefined
        ? undefined
        : {
            submissionId: SubmissionIdSchema.parse(input.submissionIdentity.submissionId),
            payloadHash: AttachmentSha256Schema.parse(input.submissionIdentity.payloadHash),
          };
    if (
      (currentRun.submissionId === undefined) !== (submissionIdentity === undefined) ||
      (submissionIdentity !== undefined &&
        currentRun.submissionId !== submissionIdentity.submissionId)
    ) {
      throw new StorageConflictError(
        "Run submission identity does not match the reserved submission.",
      );
    }

    const dataJson = encodeProtocol(CurrentAgentRunSchema, currentRun, {
      entityType: "AgentRun",
      entityId: currentRun.id,
      table: "agent_runs",
    });
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      assertArchiveWritableInTransaction(this.database, {
        type: "SESSION",
        sessionId: currentRun.sessionId,
      });
      assertArchiveWritableInTransaction(this.database, {
        type: "WORKSPACE",
        workspaceId: currentRun.workspace.id,
      });
      client
        .prepare(
          "INSERT INTO agent_runs " +
            "(id, session_id, protocol_version, status, created_at_ms, started_at_ms, finished_at_ms, data_json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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

      if (workflowProfile !== undefined) {
        client
          .prepare(
            "INSERT INTO run_workflow_profiles (run_id, profile_version, data_json) VALUES (?, ?, ?)",
          )
          .run(
            workflowProfile.runId,
            workflowProfile.profileVersion,
            encodeWorkflowExecutionProfile(workflowProfile),
          );
      }

      const insertResource = client.prepare(
        "INSERT INTO run_prepared_resources " +
          "(binding_id, run_id, resource_kind, resource_id, resource_revision, artifact_ref, " +
          "source_fingerprint, utf8_bytes, token_estimate, source_tool_invocation_id, " +
          "activation_ordinal, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      resources.forEach((draft, activationOrdinal) => {
        const record = WorkflowResourceBindingV1Schema.parse({
          ...draft,
          bindingId: randomUUID(),
          activationOrdinal,
        });
        insertResource.run(
          record.bindingId,
          record.runId,
          record.resourceKind,
          record.resourceId,
          record.resourceRevision,
          record.artifactRef,
          record.sourceFingerprint,
          record.utf8Bytes,
          record.tokenEstimate,
          record.sourceToolInvocationId ?? null,
          record.activationOrdinal,
          encodePreparedResourceRecord(record),
        );
      });

      if (submissionIdentity !== undefined) {
        this.assertSubmissionIdentityInTransaction(submissionIdentity, currentRun);
        bindSubmissionRunInTransaction(
          this.database,
          submissionIdentity.submissionId,
          currentRun.id,
        );
      }

      const committed = appendDurableEventsInTransaction(client, input.events);
      client.exec("COMMIT");
      return committed;
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch {
        throw new StorageError(
          "Unable to insert AgentRun " + currentRun.id + " after transaction failure",
          { cause: error },
        );
      }
      mapRepositoryError(error, "insert", currentRun.id);
    }
  }

  private assertSubmissionIdentityInTransaction(
    identity: RunSubmissionIdentity,
    run: AgentRun,
  ): void {
    const stored = this.database.client
      .prepare("SELECT payload_hash, session_id, run_id FROM submissions WHERE submission_id = ?")
      .get(identity.submissionId) as
      { payload_hash: string; session_id: string | null; run_id: string | null } | undefined;
    if (stored === undefined) throw new StorageNotFoundError("Submission", identity.submissionId);
    if (stored.payload_hash !== identity.payloadHash) {
      throw new StorageConflictError("Submission ID was already used for a different payload.");
    }
    if (stored.session_id !== null && stored.session_id !== run.sessionId) {
      throw new StorageConflictError("Submission is already bound to another Session.");
    }
    if (stored.run_id !== null && stored.run_id !== run.id) {
      throw new StorageConflictError("Submission is already bound to another Run.");
    }
  }

  async readPreparedResources(runId: RunId): Promise<readonly WorkflowResourceBindingV1[]> {
    try {
      const rows = this.database.client
        .prepare(
          "SELECT binding_id, run_id, resource_kind, resource_id, resource_revision, artifact_ref, " +
            "source_fingerprint, utf8_bytes, token_estimate, source_tool_invocation_id, " +
            "activation_ordinal, data_json FROM run_prepared_resources " +
            "WHERE run_id = ? ORDER BY activation_ordinal ASC",
        )
        .all(runId) as Array<{
        binding_id: string;
        run_id: string;
        resource_kind: string;
        resource_id: string;
        resource_revision: string;
        artifact_ref: string;
        source_fingerprint: string;
        utf8_bytes: number;
        token_estimate: number;
        source_tool_invocation_id: string | null;
        activation_ordinal: number;
        data_json: string;
      }>;
      return rows.map((row) => {
        const record = decodePreparedResourceRecord(row.data_json, {
          bindingId: row.binding_id,
          runId,
        });
        if (
          record.runId !== row.run_id ||
          record.resourceKind !== row.resource_kind ||
          record.resourceId !== row.resource_id ||
          record.resourceRevision !== row.resource_revision ||
          record.artifactRef !== row.artifact_ref ||
          record.sourceFingerprint !== row.source_fingerprint ||
          record.utf8Bytes !== row.utf8_bytes ||
          record.tokenEstimate !== row.token_estimate ||
          (record.sourceToolInvocationId ?? null) !== row.source_tool_invocation_id ||
          record.activationOrdinal !== row.activation_ordinal
        ) {
          throw new StorageDecodeError(
            "WorkflowResourceBindingV1",
            row.binding_id,
            "run_prepared_resources",
          );
        }
        return record;
      });
    } catch (error) {
      mapRepositoryError(error, "read prepared resources for", runId);
    }
  }

  async readPreparedInputReceipts(
    runId: RunId,
  ): Promise<readonly PreparedInputResourceReceiptV1[]> {
    try {
      const rows = this.database.client
        .prepare(
          `SELECT receipt.run_id, receipt.step_id, receipt.binding_id,
                  receipt.projection_fingerprint, receipt.renderer_version,
                  step.run_id AS step_run_id, binding.run_id AS binding_run_id
           FROM prepared_input_resource_receipts AS receipt
           JOIN agent_steps AS step ON step.id = receipt.step_id
           JOIN run_prepared_resources AS binding ON binding.binding_id = receipt.binding_id
           WHERE receipt.run_id = ?
           ORDER BY step.sequence ASC, receipt.binding_id ASC`,
        )
        .all(runId) as Array<{
        readonly run_id: string;
        readonly step_id: string;
        readonly binding_id: string;
        readonly projection_fingerprint: string;
        readonly renderer_version: string;
        readonly step_run_id: string;
        readonly binding_run_id: string;
      }>;
      return rows.map((row) => {
        let receipt: PreparedInputResourceReceiptV1;
        try {
          receipt = PreparedInputResourceReceiptV1Schema.parse({
            runId: row.run_id,
            stepId: row.step_id,
            bindingId: row.binding_id,
            projectionFingerprint: row.projection_fingerprint,
            rendererVersion: row.renderer_version,
          });
        } catch (error) {
          throw new StorageDecodeError(
            "PreparedInputResourceReceiptV1",
            row.binding_id,
            "prepared_input_resource_receipts",
            { cause: error },
          );
        }
        if (
          row.run_id !== runId ||
          row.step_run_id !== runId ||
          row.binding_run_id !== runId ||
          !/^sha256:[a-f0-9]{64}$/u.test(receipt.projectionFingerprint)
        ) {
          throw new StorageDecodeError(
            "PreparedInputResourceReceiptV1",
            row.binding_id,
            "prepared_input_resource_receipts",
          );
        }
        return receipt;
      });
    } catch (error) {
      mapRepositoryError(error, "read prepared input receipts for", runId);
    }
  }

  async readWorkflowProfile(runId: RunId): Promise<RunWorkflowExecutionProfileV1 | null> {
    try {
      const row = this.database.client
        .prepare("SELECT profile_version, data_json FROM run_workflow_profiles WHERE run_id = ?")
        .get(runId) as { profile_version: number; data_json: string } | undefined;
      if (row === undefined) return null;
      const profile = decodeWorkflowExecutionProfile(row.data_json, runId);
      if (profile.profileVersion !== row.profile_version) {
        throw new StorageDecodeError(
          "RunWorkflowExecutionProfileV1",
          runId,
          "run_workflow_profiles",
        );
      }
      return profile;
    } catch (error) {
      mapRepositoryError(error, "read workflow profile for", runId);
    }
  }

  async isWorkflowArtifactReferenced(artifactRef: WorkflowArtifactRef): Promise<boolean> {
    const reference = WorkflowArtifactRefSchema.parse(artifactRef);
    try {
      const row = this.database.client
        .prepare(
          "SELECT 1 AS referenced FROM run_prepared_resources WHERE artifact_ref = ? " +
            "UNION ALL SELECT 1 AS referenced FROM run_workflow_profiles " +
            "WHERE json_extract(data_json, '$.catalogSnapshotRef.artifactRef') = ? LIMIT 1",
        )
        .get(reference, reference) as { referenced: number } | undefined;
      return row !== undefined;
    } catch (error) {
      mapRepositoryError(error, "check workflow artifact reference", reference);
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
    withArchiveWriteTransaction(this.database, () => this.updateInTransaction(run));
  }

  private updateInTransaction(run: AgentRun): void {
    const stored = this.database.client
      .prepare("SELECT data_json FROM agent_runs WHERE id = ?")
      .get(run.id) as { data_json: string } | undefined;
    if (stored === undefined) throw new StorageNotFoundError("AgentRun", run.id);
    const previous = decodeProtocol(AgentRunSchema, stored.data_json, {
      entityType: "AgentRun",
      entityId: run.id,
      table: "agent_runs",
    });
    assertArchiveWritableInTransaction(this.database, {
      type: "SESSION",
      sessionId: previous.sessionId,
    });
    assertArchiveWritableInTransaction(this.database, {
      type: "SESSION",
      sessionId: run.sessionId,
    });
    assertArchiveWritableInTransaction(this.database, {
      type: "WORKSPACE",
      workspaceId: run.workspace.id,
    });
    const schema =
      previous.contextBudgetPolicy === undefined ? AgentRunSchema : CurrentAgentRunSchema;
    const currentRun = schema.parse(run);
    const dataJson = encodeProtocol(schema, currentRun, {
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
