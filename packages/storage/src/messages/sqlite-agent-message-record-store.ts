import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";
import type {
  AgentMessageAudience,
  AgentMessageRecord,
  AgentMessageRecordDraft,
  AgentMessageSource,
} from "@caelush/agent";

import type { CaelushDatabase } from "../database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "../errors.js";

/**
 * The SQLite Message V2 record store.
 *
 * ```text
 * @caelush/agent      owns AgentMessageRecordStorePort
 * @caelush/storage    implements it here, as an outer adapter
 * ```
 *
 * ## What this layer is allowed to know
 *
 * ```text
 * SQL read and write · row serialization · source and audience JSON
 * sequence assignment · foreign identity validation · transactions
 * record envelope validation
 * ```
 *
 * ## What it must never do
 *
 * ```text
 * decode an AgentMessage        the codec registry is the one decoding authority
 * project to AI                 the projector registry owns the model view
 * group for Context             the Context Engine owns selection
 * render a transcript           the Client owns presentation
 * branch on a provider          no provider concept exists at this layer
 * execute a Tool                execution belongs to the Tool Layer
 * ```
 *
 * It knows `AgentMessageRecord` and `AgentMessageRecordDraft`, and nothing about what either means.
 */

/** A row of `agent_messages`, as SQLite returns it. */
interface MessageRow {
  message_id: string;
  run_id: string;
  session_id: string;
  sequence: number;
  conversation_turn_id: string;
  message_type: string;
  schema_version: number;
  model_projection_version: number | null;
  source_step_id: string | null;
  created_at_ms: number;
  source_json: string;
  audience_json: string;
  data_json: string;
}

const ROW_COLUMNS = `message_id, run_id, session_id, sequence, conversation_turn_id, message_type,
   schema_version, model_projection_version, source_step_id, created_at_ms, source_json, audience_json,
   data_json`;

/**
 * Append Message V2 records inside a transaction the **caller** owns.
 *
 * ```text
 * this function   does not BEGIN and does not COMMIT
 * its caller      owns the transaction boundary
 * ```
 *
 * ## Why the split exists now rather than in Phase 5C
 *
 * Phase 5C must commit the Run, its AgentState, the Step, the conversation messages, the continuation
 * and the durable events in **one** atomic execution commit. If this store owned the transaction, 5C
 * would have to either nest a transaction inside that commit — which SQLite does not support — or
 * rewrite the append path. Establishing the transaction-neutral helper and the
 * transaction-owning public wrapper now means 5C composes this function into its existing
 * `BEGIN IMMEDIATE` without changing the sequence authority at all.
 *
 * ## Sequence assignment
 *
 * One `SELECT MAX(sequence)` for the Run, then one contiguous range. Because the caller holds the
 * transaction — and the public wrapper opens it with `BEGIN IMMEDIATE` — two concurrent appends to one
 * Run cannot interleave, so a batch is either wholly visible or wholly absent and no sequence is
 * reused.
 */
export function appendAgentMessageRecordsInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  drafts: readonly AgentMessageRecordDraft[],
): AgentMessageRecord[] {
  if (drafts.length === 0) return [];

  const run = client.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(runId) as
    { session_id: string } | undefined;
  if (run === undefined) {
    throw new StorageDecodeError("AgentMessageRecord", runId, "agent_runs");
  }

  // Every record in one batch is bound to the Run the caller named, and that Run owns exactly one
  // Session. A draft claiming another Session would produce a message no session read could find.
  for (const draft of drafts) {
    if (draft.sessionId !== run.session_id) {
      throw new StorageDecodeError(
        "AgentMessageRecord",
        `${runId}:${draft.messageId}`,
        "agent_runs",
      );
    }
  }

  // A present step pointer must belong to this Run: a cross-Run pointer would attribute a message to
  // a Step that never produced it.
  for (const draft of drafts) {
    if (draft.sourceStepId === undefined) continue;
    const step = client
      .prepare("SELECT run_id FROM agent_steps WHERE id = ?")
      .get(draft.sourceStepId) as { run_id: string } | undefined;
    if (step === undefined || step.run_id !== runId) {
      throw new StorageDecodeError(
        "AgentMessageRecord",
        `${runId}:${draft.messageId}`,
        "agent_steps",
      );
    }
  }

  const existing = client
    .prepare("SELECT message_id FROM agent_messages WHERE run_id = ?")
    .all(runId) as Array<{ message_id: string }>;
  const known = new Set(existing.map((row) => row.message_id));
  for (const draft of drafts) {
    if (known.has(draft.messageId)) {
      throw new StorageConflictError(`Message ${draft.messageId} already exists in Run ${runId}`);
    }
    known.add(draft.messageId);
  }

  const last = client
    .prepare("SELECT sequence FROM agent_messages WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(runId) as { sequence: number } | undefined;
  const firstSequence = (last?.sequence ?? 0) + 1;

  const insert = client.prepare(
    `INSERT INTO agent_messages
      (message_id, run_id, session_id, sequence, conversation_turn_id, message_type, schema_version,
       model_projection_version, source_step_id, created_at_ms, source_json, audience_json, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return drafts.map((draft, offset) => {
    assertRecordDraft(draft);
    const sequence = firstSequence + offset;
    insert.run(
      draft.messageId,
      runId,
      draft.sessionId,
      sequence,
      draft.conversationTurnId,
      draft.messageType,
      draft.schemaVersion,
      draft.modelProjectionVersion ?? null,
      draft.sourceStepId ?? null,
      draft.createdAt,
      JSON.stringify(draft.source),
      JSON.stringify(draft.audience),
      JSON.stringify(draft.data),
    );
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
  });
}

/**
 * Structural validation of one draft, before any row is written.
 *
 * Every check here is a fact the *envelope* owns. None of them looks inside `data`, because what the
 * payload means is the codec's question and this layer has no codec.
 */
function assertRecordDraft(draft: AgentMessageRecordDraft): void {
  const fail = (field: string): never => {
    void field;
    throw new StorageDecodeError(
      "AgentMessageRecordDraft",
      String(draft.messageId),
      "agent_messages",
    );
  };
  if (typeof draft.messageId !== "string" || draft.messageId.length === 0) fail("messageId");
  if (typeof draft.sessionId !== "string" || draft.sessionId.length === 0) fail("sessionId");
  if (typeof draft.conversationTurnId !== "string" || draft.conversationTurnId.length === 0) {
    fail("conversationTurnId");
  }
  if (typeof draft.messageType !== "string" || draft.messageType.length === 0) fail("messageType");
  if (!Number.isSafeInteger(draft.schemaVersion) || draft.schemaVersion < 1) fail("schemaVersion");
  if (draft.modelProjectionVersion !== undefined) {
    if (!Number.isSafeInteger(draft.modelProjectionVersion) || draft.modelProjectionVersion < 1) {
      fail("modelProjectionVersion");
    }
  }
  if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0) fail("createdAt");
  if (typeof draft.source !== "object" || draft.source === null) fail("source");
  if (typeof draft.audience !== "object" || draft.audience === null) fail("audience");
  if (typeof draft.data !== "object" || draft.data === null || Array.isArray(draft.data)) {
    fail("data");
  }

  /*
   * The projection-version rule, enforced structurally rather than only at the codec boundary.
   *
   * A model-visible message records the projector version that produced its model view; a message the
   * model never sees has no model view, so it must NOT record one. Both directions fail closed here, so
   * a caller that bypassed the codec registry cannot write a row that later reads as an unversioned
   * projection.
   */
  const audience = draft.audience as AgentMessageAudience;
  if (audience.model === true && draft.modelProjectionVersion === undefined) {
    throw new StorageDecodeError(
      "AgentMessageRecordDraft",
      `${draft.messageId}:modelProjectionVersion`,
      "agent_messages",
    );
  }
  if (audience.model === false && draft.modelProjectionVersion !== undefined) {
    throw new StorageDecodeError(
      "AgentMessageRecordDraft",
      `${draft.messageId}:modelProjectionVersion`,
      "agent_messages",
    );
  }
}

/** Decode one row that carries a V2 record. Throws when the row is legacy-only. */
function rowToRecord(row: MessageRow): AgentMessageRecord {
  const identity = `${row.run_id}:${String(row.sequence)}`;
  return {
    messageId: row.message_id as AgentMessageRecord["messageId"],
    runId: row.run_id as RunId,
    sessionId: row.session_id as SessionId,
    sequence: row.sequence,
    conversationTurnId: row.conversation_turn_id as AgentMessageRecord["conversationTurnId"],
    messageType: row.message_type,
    schemaVersion: row.schema_version,
    ...(row.model_projection_version === null
      ? {}
      : { modelProjectionVersion: row.model_projection_version }),
    ...(row.source_step_id === null ? {} : { sourceStepId: row.source_step_id as StepId }),
    createdAt: row.created_at_ms as TimestampMs,
    source: parseJsonColumn<AgentMessageSource>(row.source_json, identity),
    audience: parseJsonColumn<AgentMessageAudience>(row.audience_json, identity),
    data: parseJsonColumn<AgentMessageRecord["data"]>(row.data_json, identity),
  };
}

function parseJsonColumn<T>(value: string, identity: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new StorageDecodeError("AgentMessageRecord", identity, "agent_messages");
  }
}

/** Map a storage failure to the storage error vocabulary without leaking a driver message. */
function mapWriteError(error: unknown, runId: RunId): never {
  if (error instanceof StorageError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to append agent messages for Run ${runId}`, {
      cause: error,
    });
  }
  throw new StorageError(`Unable to append agent messages for Run ${runId}`, { cause: error });
}

/**
 * The Message V2 record store as an `AgentMessageRecordStorePort`.
 *
 * ## The public `append` owns the transaction
 *
 * ```text
 * public append()                    BEGIN IMMEDIATE … COMMIT
 * appendAgentMessageRecordsInTransaction()   no BEGIN, no COMMIT
 * ```
 *
 * A failed append rolls the whole batch back and **consumes no sequence**: the range was computed
 * inside the transaction that rolled back, so the next successful append continues from the last
 * durable sequence rather than from a number no row ever held.
 *
 * ## Reads are not writes
 *
 * Historical conversion is complete before a storage facade is exposed. Reads therefore return only
 * final V2 rows and never become an implicit migration.
 */
export class SqliteAgentMessageRecordStore {
  /**
   * The database this store writes through.
   *
   * Exposed because a `:memory:` SQLite database is scoped to its connection, so a caller that needs to
   * run raw SQL against the same database — a one-shot data migration, or a test fixture seeding a
   * legacy row — must use the connection the store already holds rather than open a second one.
   */
  constructor(readonly database: CaelushDatabase) {}

  async append(
    runId: RunId,
    records: readonly AgentMessageRecordDraft[],
  ): Promise<readonly AgentMessageRecord[]> {
    if (records.length === 0) return Object.freeze([]);
    const client = this.database.client;
    // IMMEDIATE rather than DEFERRED: the sequence range is read and then written, so the write lock
    // must be taken before the read or two appends could compute the same range.
    client.exec("BEGIN IMMEDIATE");
    try {
      const appended = appendAgentMessageRecordsInTransaction(client, runId, records);
      client.exec("COMMIT");
      return Object.freeze([...appended]);
    } catch (error) {
      client.exec("ROLLBACK");
      mapWriteError(error, runId);
    }
  }

  async listByRun(runId: RunId): Promise<readonly AgentMessageRecord[]> {
    const rows = this.database.client
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM agent_messages
         WHERE run_id = ? ORDER BY sequence ASC`,
      )
      .all(runId) as unknown as MessageRow[];
    return Object.freeze(rows.map(rowToRecord));
  }

  /**
   * Every final V2 record of one Session, in deterministic creation order.
   *
   * The repository still owns turn semantics; this store owns only the physical record ordering.
   */
  async listBySession(sessionId: SessionId): Promise<readonly AgentMessageRecord[]> {
    const rows = this.database.client
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM agent_messages
         WHERE session_id = ?
         ORDER BY created_at_ms ASC, run_id ASC, sequence ASC`,
      )
      .all(sessionId) as unknown as MessageRow[];
    return Object.freeze(rows.map(rowToRecord));
  }
}
