import { createHash } from "node:crypto";
import type { DurableRunEventDraft } from "@caelush/agent";
import {
  evaluateRunInputAdmission,
  type PendingRunInput,
  type RunInputRejectionReason,
  type RunInputSnapshot,
} from "@caelush/agent";
import type { RunId } from "@caelush/protocol";
import {
  RUN_INPUT_BATCH_MAX_BYTES,
  RUN_INPUT_BATCH_MAX_COUNT,
  RUN_INPUT_TEXT_MAX_BYTES,
  RUN_INPUT_UNASSIGNED_MAX_BYTES,
  RUN_INPUT_UNASSIGNED_MAX_COUNT,
  utf8ByteLength,
  type RunInputStage,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { StorageDecodeError, StorageError } from "./errors.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { withAuthoritativeTransaction } from "./transaction-guard.js";

/**
 * The durable Run input store.
 *
 * ```text
 * T1  accept    short, synchronous critical section: verify, allocate, insert, event
 * T2  handoff   written by the Run authority commit, never by this class on its own
 * T3  assign    written by the Step-open commit, never by this class on its own
 * ```
 *
 * Only T1 lives here as a public operation. T2 and T3 are *fields* of the Run execution commit, so
 * an input can never be re-staged independently of the USER record that consumed it, and a first
 * Step association can never be written for a Step that did not open.
 */

export interface RunInputRecord {
  readonly inputId: string;
  readonly runId: RunId;
  readonly acceptedSequence: number;
  readonly stage: RunInputStage;
  readonly acceptedAt: number;
  readonly messageId?: string;
  readonly firstStepId?: string;
}

interface RunInputRow {
  readonly input_id: string;
  readonly run_id: string;
  readonly accepted_sequence: number;
  readonly stage: string;
  readonly payload_hash: string;
  readonly byte_length: number;
  readonly staged_text: string | null;
  readonly message_id: string | null;
  readonly first_step_id: string | null;
  readonly accepted_at_ms: number;
}

function decodeRow(row: RunInputRow): RunInputRecord {
  if (row.stage !== "PENDING" && row.stage !== "RECORDED" && row.stage !== "ASSIGNED") {
    throw new StorageDecodeError("RunInput", row.input_id, "run_inputs");
  }
  return {
    inputId: row.input_id,
    runId: row.run_id as RunId,
    acceptedSequence: row.accepted_sequence,
    stage: row.stage,
    acceptedAt: row.accepted_at_ms,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    ...(row.first_step_id === null ? {} : { firstStepId: row.first_step_id }),
  };
}

/**
 * The canonical payload hash.
 *
 * It binds the record version, the Run and the complete text, which is what makes "same identity,
 * different payload" a conflict rather than a silent overwrite. It never leaves storage.
 */
export function runInputPayloadHash(runId: RunId, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, runId, text }), "utf8")
    .digest("hex");
}

export interface AcceptRunInputCommand {
  readonly runId: RunId;
  readonly inputId: string;
  readonly text: string;
  readonly now: number;
  /**
   * Builds the `run.input.accepted` draft once the sequence is known.
   *
   * A callback rather than a value because the sequence is allocated inside this transaction, and
   * an event that guessed it would disagree with the row it describes.
   */
  readonly buildEvent: (acceptedSequence: number) => DurableRunEventDraft;
}

export type AcceptRunInputResult =
  | { readonly kind: "ACCEPTED"; readonly record: RunInputRecord }
  /** An exact retry of an identity this Run already holds. It is not a new acceptance. */
  | { readonly kind: "EXISTING"; readonly record: RunInputRecord }
  | {
      readonly kind: "REJECTED";
      readonly reason:
        RunInputRejectionReason | "IDEMPOTENCY_CONFLICT" | "QUEUE_FULL" | "TEXT_TOO_LARGE";
    };

interface RunFactsRow {
  readonly status: string;
  readonly started_at_ms: number | null;
  readonly data_json: string;
}

interface RunFacts {
  readonly status: string;
  readonly startedAt: number | undefined;
  readonly completionContract: string | undefined;
  readonly timeoutMs: number | undefined;
}

function loadRunFacts(client: CaelushDatabase["client"], runId: RunId): RunFacts | undefined {
  const row = client
    .prepare("SELECT status, started_at_ms, data_json FROM agent_runs WHERE id = ?")
    .get(runId) as RunFactsRow | undefined;
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch (error) {
    throw new StorageDecodeError("AgentRun", runId, "agent_runs", {
      cause: error,
    });
  }
  const object =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const limits = object["limits"];
  const timeoutMs =
    typeof limits === "object" &&
    limits !== null &&
    typeof (limits as Record<string, unknown>)["timeoutMs"] === "number"
      ? ((limits as Record<string, unknown>)["timeoutMs"] as number)
      : undefined;
  const completionContract =
    typeof object["completionContract"] === "string" ? object["completionContract"] : undefined;
  return {
    status: row.status,
    startedAt: row.started_at_ms ?? undefined,
    completionContract,
    timeoutMs,
  };
}

function deadlineExceeded(facts: RunFacts, now: number): boolean {
  if (facts.status === "PENDING" || facts.startedAt === undefined) return false;
  if (facts.timeoutMs === undefined || !Number.isSafeInteger(facts.timeoutMs)) return false;
  return now - facts.startedAt >= facts.timeoutMs;
}

function loadByInputId(
  client: CaelushDatabase["client"],
  inputId: string,
): (RunInputRow & { readonly run_id: string }) | undefined {
  return client.prepare("SELECT * FROM run_inputs WHERE input_id = ?").get(inputId) as
    (RunInputRow & { readonly run_id: string }) | undefined;
}

function unassignedUsage(
  client: CaelushDatabase["client"],
  runId: RunId,
): { readonly count: number; readonly bytes: number } {
  const row = client
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes
       FROM run_inputs WHERE run_id = ? AND stage IN ('PENDING', 'RECORDED')`,
    )
    .get(runId) as { readonly count: number; readonly bytes: number };
  return { count: row.count, bytes: row.bytes };
}

export class SqliteRunInputStore {
  constructor(private readonly database: CaelushDatabase) {}

  /**
   * T1 — accept one input, or explain why not.
   *
   * ```text
   * ownership → idempotency → policy → capacity → allocate → insert → event
   * ```
   *
   * The caller has already opened a transaction through the connection guard; this method performs
   * no `await`, so the critical section is genuinely short and cannot be interleaved with another
   * authoritative write on the same connection.
   */
  acceptInTransaction(command: AcceptRunInputCommand): AcceptRunInputResult {
    const client = this.database.client;
    const facts = loadRunFacts(client, command.runId);
    if (facts === undefined) return { kind: "REJECTED", reason: "TARGET_MISMATCH" };

    // Identity first: a retry that lost its ACK must find its own acceptance even when the Run has
    // since ended. This is what separates "already accepted" from "too late".
    const existing = loadByInputId(client, command.inputId);
    if (existing !== undefined) {
      if (existing.run_id !== command.runId) return { kind: "REJECTED", reason: "TARGET_MISMATCH" };
      if (existing.payload_hash !== runInputPayloadHash(command.runId, command.text)) {
        return { kind: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" };
      }
      return { kind: "EXISTING", record: decodeRow(existing) };
    }

    if (command.text.trim().length === 0) return { kind: "REJECTED", reason: "TEXT_TOO_LARGE" };
    const byteLength = utf8ByteLength(command.text);
    if (byteLength > RUN_INPUT_TEXT_MAX_BYTES) {
      return { kind: "REJECTED", reason: "TEXT_TOO_LARGE" };
    }

    const cancellation = client
      .prepare("SELECT run_id FROM run_cancellation_requests WHERE run_id = ?")
      .get(command.runId) as { readonly run_id: string } | undefined;

    const admission = evaluateRunInputAdmission({
      status: facts.status as Parameters<typeof evaluateRunInputAdmission>[0]["status"],
      completionContract: facts.completionContract,
      cancellationRequested: cancellation !== undefined,
      deadlineExceeded: deadlineExceeded(facts, command.now),
    });
    if (admission.kind === "REJECT") return { kind: "REJECTED", reason: admission.reason };

    const usage = unassignedUsage(client, command.runId);
    if (
      usage.count >= RUN_INPUT_UNASSIGNED_MAX_COUNT ||
      usage.bytes + byteLength > RUN_INPUT_UNASSIGNED_MAX_BYTES
    ) {
      return { kind: "REJECTED", reason: "QUEUE_FULL" };
    }

    client
      .prepare(
        `INSERT INTO run_input_heads (run_id, revision, last_accepted_sequence)
         VALUES (?, 1, 1)
         ON CONFLICT(run_id) DO UPDATE SET
           revision = run_input_heads.revision + 1,
           last_accepted_sequence = run_input_heads.last_accepted_sequence + 1`,
      )
      .run(command.runId);
    const head = client
      .prepare("SELECT last_accepted_sequence FROM run_input_heads WHERE run_id = ?")
      .get(command.runId) as { readonly last_accepted_sequence: number } | undefined;
    if (head === undefined) throw new StorageError("Run input sequence was not allocated.");
    const acceptedSequence = head.last_accepted_sequence;

    client
      .prepare(
        `INSERT INTO run_inputs
         (input_id, run_id, accepted_sequence, schema_version, stage, payload_hash, byte_length,
          staged_text, message_id, first_step_id, accepted_at_ms, recorded_at_ms, assigned_at_ms)
         VALUES (?, ?, ?, 1, 'PENDING', ?, ?, ?, NULL, NULL, ?, NULL, NULL)`,
      )
      .run(
        command.inputId,
        command.runId,
        acceptedSequence,
        runInputPayloadHash(command.runId, command.text),
        byteLength,
        command.text,
        command.now,
      );

    const event = command.buildEvent(acceptedSequence);
    if (event.runId !== command.runId) {
      throw new StorageError("A Run input event does not belong to the Run it accepts for.");
    }
    appendDurableEventsInTransaction(client, [event]);

    return {
      kind: "ACCEPTED",
      record: {
        inputId: command.inputId,
        runId: command.runId,
        acceptedSequence,
        stage: "PENDING",
        acceptedAt: command.now,
      },
    };
  }

  /**
   * Accept one input as its own authoritative transaction.
   *
   * It goes through the connection guard so it can never begin inside the Run completion
   * transaction, and it commits before the caller is answered.
   */
  async accept(command: AcceptRunInputCommand): Promise<AcceptRunInputResult> {
    return withAuthoritativeTransaction(this.database.client, async () => {
      const client = this.database.client;
      client.exec("BEGIN IMMEDIATE");
      try {
        const result = this.acceptInTransaction(command);
        client.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          client.exec("ROLLBACK");
        } catch {
          throw new StorageError("Run input acceptance failed after the transaction ended.", {
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  async get(runId: RunId, inputId: string): Promise<RunInputRecord | null> {
    const row = loadByInputId(this.database.client, inputId);
    if (row === undefined) return null;
    if (row.run_id !== runId) return null;
    return decodeRow(row);
  }

  async list(
    runId: RunId,
    query: { readonly after?: number; readonly limit: number },
  ): Promise<{ readonly items: readonly RunInputRecord[]; readonly nextCursor?: number }> {
    const rows = this.database.client
      .prepare(
        `SELECT * FROM run_inputs
         WHERE run_id = ? AND accepted_sequence > ?
         ORDER BY accepted_sequence ASC
         LIMIT ?`,
      )
      .all(runId, query.after ?? 0, query.limit + 1) as unknown as RunInputRow[];
    const page = rows.slice(0, query.limit);
    const items = page.map(decodeRow);
    return rows.length > query.limit
      ? { items, nextCursor: page[page.length - 1]?.accepted_sequence ?? 0 }
      : { items };
  }

  /**
   * The bounded facts one execution snapshot carries.
   *
   * The text prefix is capped by the batch limit, and the byte cap is enforced while selecting, so
   * a snapshot stays bounded even when a Run holds the maximum backlog.
   */
  snapshotFacts(runId: RunId): RunInputSnapshot {
    const client = this.database.client;
    const rows = client
      .prepare(
        `SELECT input_id, accepted_sequence, staged_text, byte_length FROM run_inputs
         WHERE run_id = ? AND stage = 'PENDING'
         ORDER BY accepted_sequence ASC
         LIMIT ?`,
      )
      .all(runId, RUN_INPUT_BATCH_MAX_COUNT + 1) as Array<{
      readonly input_id: string;
      readonly accepted_sequence: number;
      readonly staged_text: string | null;
      readonly byte_length: number;
    }>;
    const pending: PendingRunInput[] = [];
    let batchBytes = 0;
    for (const row of rows) {
      if (pending.length >= RUN_INPUT_BATCH_MAX_COUNT) break;
      if (row.staged_text === null) continue;
      if (batchBytes + row.byte_length > RUN_INPUT_BATCH_MAX_BYTES) break;
      batchBytes += row.byte_length;
      pending.push({
        inputId: row.input_id,
        acceptedSequence: row.accepted_sequence,
        text: row.staged_text,
      });
    }
    const recordedRows = client
      .prepare(
        `SELECT input_id, accepted_sequence, message_id FROM run_inputs
         WHERE run_id = ? AND stage = 'RECORDED'
         ORDER BY accepted_sequence ASC
         LIMIT ?`,
      )
      .all(runId, RUN_INPUT_UNASSIGNED_MAX_COUNT) as Array<{
      readonly input_id: string;
      readonly accepted_sequence: number;
      readonly message_id: string;
    }>;
    const counts = client
      .prepare(
        `SELECT
           SUM(CASE WHEN stage = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
           SUM(CASE WHEN stage = 'RECORDED' THEN 1 ELSE 0 END) AS recorded_count
         FROM run_inputs WHERE run_id = ?`,
      )
      .get(runId) as {
      readonly pending_count: number | null;
      readonly recorded_count: number | null;
    };
    const pendingCount = counts.pending_count ?? 0;
    const recordedCount = counts.recorded_count ?? 0;
    return {
      pending,
      recorded: recordedRows.map((row) => ({
        inputId: row.input_id,
        acceptedSequence: row.accepted_sequence,
        messageId: row.message_id,
      })),
      pendingCount,
      recordedCount,
      unassignedCount: pendingCount + recordedCount,
    };
  }
}

/**
 * T2 — record the inputs whose canonical USER records this commit wrote.
 *
 * Called from inside the Run authority commit, after the message records are appended. Every entry
 * must still be PENDING at the exact sequence the boundary froze; a moved stage means the caller's
 * batch is stale and the whole transition must roll back rather than consume an input twice.
 */
export function applyRunInputHandoffInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  handoff: {
    readonly entries: readonly { inputId: string; acceptedSequence: number; messageId: string }[];
  },
  now: number,
): void {
  for (const entry of handoff.entries) {
    const message = client
      .prepare("SELECT run_id, message_type, source_json FROM agent_messages WHERE message_id = ?")
      .get(entry.messageId) as
      | { readonly run_id: string; readonly message_type: string; readonly source_json: string }
      | undefined;
    if (
      message === undefined ||
      message.run_id !== runId ||
      message.message_type !== "USER" ||
      !message.source_json.includes('"origin":"STEERING"')
    ) {
      throw new StorageError("A Run input handoff does not match its canonical USER message.");
    }
    const result = client
      .prepare(
        `UPDATE run_inputs SET stage = 'RECORDED', staged_text = NULL, message_id = ?,
           recorded_at_ms = ?
         WHERE run_id = ? AND input_id = ? AND accepted_sequence = ? AND stage = 'PENDING'`,
      )
      .run(entry.messageId, now, runId, entry.inputId, entry.acceptedSequence);
    if (result.changes !== 1) {
      throw new StorageError("A Run input handoff raced with another acceptance.");
    }
  }
}

/**
 * T3 — associate the inputs this prepared model step actually included.
 *
 * The caller passes the intersection of the step's input message IDs and the IDs the Context plan
 * selected, so a message that was dropped before the request stays RECORDED instead of claiming an
 * association it never had.
 */
export function applyRunInputAssignmentInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  assignment: { readonly stepId: string; readonly messageIds: readonly string[] },
  now: number,
): void {
  for (const messageId of assignment.messageIds) {
    const row = client
      .prepare(`SELECT input_id, stage FROM run_inputs WHERE run_id = ? AND message_id = ?`)
      .get(runId, messageId) as { readonly input_id: string; readonly stage: string } | undefined;
    // A message that is not a steering input is not an error: any canonical USER from this Run can
    // be part of the request. Only a RECORDED input is assigned.
    if (row === undefined) continue;
    if (row.stage === "ASSIGNED") continue;
    if (row.stage !== "RECORDED") {
      throw new StorageError("A Run input was assigned before it was recorded.");
    }
    const step = client
      .prepare("SELECT run_id FROM agent_steps WHERE id = ?")
      .get(assignment.stepId) as { readonly run_id: string } | undefined;
    if (step === undefined || step.run_id !== runId) {
      throw new StorageError("A Run input assignment names a Step of another Run.");
    }
    const result = client
      .prepare(
        `UPDATE run_inputs SET stage = 'ASSIGNED', first_step_id = ?, assigned_at_ms = ?
         WHERE run_id = ? AND input_id = ? AND stage = 'RECORDED'`,
      )
      .run(assignment.stepId, now, runId, row.input_id);
    if (result.changes !== 1) {
      throw new StorageError("A Run input assignment raced with another step open.");
    }
  }
}

/** Whether this Run still holds an input no model step has included. */
export function hasUnassignedRunInputsInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
): boolean {
  const row = client
    .prepare(
      `SELECT 1 AS present FROM run_inputs
       WHERE run_id = ? AND stage IN ('PENDING', 'RECORDED') LIMIT 1`,
    )
    .get(runId) as { readonly present: number } | undefined;
  return row !== undefined;
}
