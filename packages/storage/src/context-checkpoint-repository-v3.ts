import type {
  ContextCheckpointCreateInputV3,
  ContextCheckpointRecordV2,
  ContextCheckpointRecordV3,
  ContextCheckpointSessionCandidates,
  ContextCheckpointV3RepositoryPort,
  LegacyContextCheckpointRecordV1,
} from "@caelush/agent";
import { canonicalJsonText } from "@caelush/agent";
import type { RunId, SessionId } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";
import {
  CONTEXT_CHECKPOINT_V3_SELECT,
  decodeContextCheckpointV3,
  encodeContextCheckpointV3,
  type ContextCheckpointV3Row,
} from "./context-checkpoint-codec-v3.js";
import { SqliteContextCheckpointRepositoryV2 } from "./context-checkpoint-repository-v2.js";

interface CandidateRow extends ContextCheckpointV3Row {
  readonly owner_created_at_ms: number;
}

interface CandidateCursor {
  readonly ownerCreatedAtMs: number;
  readonly ownerRunId: string;
  readonly ownerStepSequence: number;
  readonly checkpointCreatedAtMs: number;
  readonly checkpointId: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Session-scoped V3 codec and bounded historical candidate reader. */
export class SqliteContextCheckpointRepositoryV3 implements ContextCheckpointV3RepositoryPort {
  private readonly previousVersions: SqliteContextCheckpointRepositoryV2;

  constructor(private readonly database: CaelushDatabase) {
    this.previousVersions = new SqliteContextCheckpointRepositoryV2(database);
  }

  async getById(checkpointId: string): Promise<ContextCheckpointRecordV3 | undefined> {
    const row = this.database.client
      .prepare(`${CONTEXT_CHECKPOINT_V3_SELECT} WHERE id = ?`)
      .get(checkpointId) as ContextCheckpointV3Row | undefined;
    if (row === undefined) return undefined;
    if (row.summary_version !== 3) return undefined;
    return decodeContextCheckpointV3(row);
  }

  async listCandidatesBySession(input: {
    readonly sessionId: SessionId;
    readonly throughRunId: RunId;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ContextCheckpointSessionCandidates> {
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RangeError(`Context checkpoint page size must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
    const throughRun = this.database.client
      .prepare("SELECT session_id, created_at_ms FROM agent_runs WHERE id = ?")
      .get(input.throughRunId) as
      { readonly session_id: string; readonly created_at_ms: number } | undefined;
    if (throughRun === undefined || throughRun.session_id !== input.sessionId) {
      throw new StorageError("Context checkpoint candidate boundary is outside the Session.");
    }
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const cursorSql =
      cursor === undefined
        ? ""
        : ` AND (
             run.created_at_ms < ?
             OR (run.created_at_ms = ? AND checkpoint.run_id < ?)
             OR (run.created_at_ms = ? AND checkpoint.run_id = ? AND COALESCE(checkpoint.owner_step_sequence, 0) < ?)
             OR (run.created_at_ms = ? AND checkpoint.run_id = ? AND COALESCE(checkpoint.owner_step_sequence, 0) = ? AND checkpoint.created_at_ms < ?)
             OR (run.created_at_ms = ? AND checkpoint.run_id = ? AND COALESCE(checkpoint.owner_step_sequence, 0) = ? AND checkpoint.created_at_ms = ? AND checkpoint.id < ?)
           )`;
    const sql = `SELECT checkpoint.id, checkpoint.run_id, checkpoint.session_id,
           checkpoint.previous_checkpoint_id, checkpoint.owner_step_sequence,
           checkpoint.activation_operation_id, checkpoint.coverage_digest,
           checkpoint.source_sequence_from, checkpoint.source_sequence_to,
           checkpoint.tokens_before, checkpoint.tokens_after, checkpoint.summary_version,
           checkpoint.model_ref_json, checkpoint.created_at_ms, checkpoint.data_json,
           checkpoint.read_file_refs_json, checkpoint.changed_file_refs_json,
           run.created_at_ms AS owner_created_at_ms
         FROM context_checkpoints AS checkpoint
         INNER JOIN agent_runs AS run ON run.id = checkpoint.run_id
         WHERE checkpoint.session_id = ?
           AND (run.created_at_ms < ? OR (run.created_at_ms = ? AND run.id <= ?))
           AND (checkpoint.run_id = ? OR run.finished_at_ms IS NOT NULL)
           ${cursorSql}
         ORDER BY run.created_at_ms DESC, checkpoint.run_id DESC,
           COALESCE(checkpoint.owner_step_sequence, 0) DESC,
           checkpoint.created_at_ms DESC, checkpoint.id DESC
         LIMIT ?`;
    const parameters: (string | number | null)[] = [
      input.sessionId,
      throughRun.created_at_ms,
      throughRun.created_at_ms,
      input.throughRunId,
      input.throughRunId,
    ];
    if (cursor !== undefined) {
      parameters.push(
        cursor.ownerCreatedAtMs,
        cursor.ownerCreatedAtMs,
        cursor.ownerRunId,
        cursor.ownerCreatedAtMs,
        cursor.ownerRunId,
        cursor.ownerStepSequence,
        cursor.ownerCreatedAtMs,
        cursor.ownerRunId,
        cursor.ownerStepSequence,
        cursor.checkpointCreatedAtMs,
        cursor.ownerCreatedAtMs,
        cursor.ownerRunId,
        cursor.ownerStepSequence,
        cursor.checkpointCreatedAtMs,
        cursor.checkpointId,
      );
    }
    parameters.push(limit + 1);
    const rows = this.database.client.prepare(sql).all(...parameters) as unknown as CandidateRow[];
    const page = rows.slice(0, limit);
    const records: Array<
      ContextCheckpointRecordV3 | ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1
    > = [];
    for (const row of page) {
      if (row.summary_version === 3) records.push(decodeContextCheckpointV3(row));
      else {
        const previous = await this.previousVersions.getById(row.id);
        if (previous === undefined)
          throw new StorageError("Historical Context checkpoint is unavailable.");
        records.push(previous);
      }
    }
    const next = rows.length > limit ? page[page.length - 1] : undefined;
    return Object.freeze({
      records: Object.freeze(records),
      ...(next === undefined ? {} : { nextCursor: encodeCursor(cursorFromRow(next)) }),
    });
  }
}

export function writeContextCheckpointV3InTransaction(
  database: CaelushDatabase,
  input: ContextCheckpointCreateInputV3,
):
  | { readonly kind: "INSERTED" }
  | { readonly kind: "IDEMPOTENT_EXISTING"; readonly checkpoint: ContextCheckpointRecordV3 } {
  const envelope = encodeContextCheckpointV3(input);
  assertCoverageRowsInTransaction(database, input);
  const owner = database.client
    .prepare("SELECT session_id, created_at_ms FROM agent_runs WHERE id = ?")
    .get(input.ownerRunId) as
    { readonly session_id: string; readonly created_at_ms: number } | undefined;
  if (owner === undefined || owner.session_id !== input.sessionId) {
    throw new StorageError("Context Checkpoint V3 owner Run is outside the Session.");
  }
  for (const runId of new Set(input.coverage.segments.map((segment) => String(segment.runId)))) {
    const source = database.client
      .prepare("SELECT session_id, created_at_ms, finished_at_ms FROM agent_runs WHERE id = ?")
      .get(runId) as
      | {
          readonly session_id: string;
          readonly created_at_ms: number;
          readonly finished_at_ms: number | null;
        }
      | undefined;
    if (source === undefined || source.session_id !== input.sessionId) {
      throw new StorageError("Context Checkpoint V3 source Run is outside the Session.");
    }
    if (
      runId !== input.ownerRunId &&
      (source.finished_at_ms === null ||
        source.created_at_ms > owner.created_at_ms ||
        (source.created_at_ms === owner.created_at_ms && runId >= input.ownerRunId))
    ) {
      throw new StorageError("Context Checkpoint V3 source Run is not an earlier closed Run.");
    }
  }
  const step = database.client
    .prepare("SELECT 1 AS present FROM agent_steps WHERE run_id = ? AND sequence = ?")
    .get(input.ownerRunId, input.ownerStepSequence);
  if (step === undefined) {
    // Context preparation runs before ModelTurnBoundary durably opens the in-memory pending Step.
    // A checkpoint can therefore belong to exactly the next Step, but never to a skipped sequence.
    const latest = database.client
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_steps WHERE run_id = ?")
      .get(input.ownerRunId) as { readonly sequence: number };
    if (input.ownerStepSequence !== latest.sequence + 1) {
      throw new StorageError("Context Checkpoint V3 owner Step is unavailable.");
    }
  }
  if (input.previousCheckpointId !== undefined) {
    const previous = database.client
      .prepare("SELECT session_id FROM context_checkpoints WHERE id = ?")
      .get(input.previousCheckpointId) as { readonly session_id: string } | undefined;
    if (previous === undefined || previous.session_id !== input.sessionId) {
      throw new StorageError("Context Checkpoint V3 predecessor is outside the Session.");
    }
  }

  const existing = database.client
    .prepare(`${CONTEXT_CHECKPOINT_V3_SELECT} WHERE id = ?`)
    .get(input.checkpointId) as ContextCheckpointV3Row | undefined;
  if (existing !== undefined) {
    if (existing.summary_version !== 3) {
      throw new StorageConflictError(
        "Context Checkpoint V3 identity collides with a prior schema.",
      );
    }
    const checkpoint = decodeContextCheckpointV3(existing);
    if (
      canonicalJsonText(checkpoint as never) !==
      canonicalJsonText({ ...input, schemaVersion: 3 } as never)
    ) {
      throw new StorageConflictError("Context Checkpoint V3 has conflicting immutable content.");
    }
    return Object.freeze({ kind: "IDEMPOTENT_EXISTING", checkpoint });
  }

  try {
    database.client
      .prepare(
        `INSERT INTO context_checkpoints
         (id, run_id, session_id, previous_checkpoint_id, owner_step_sequence,
          activation_operation_id, coverage_digest, source_sequence_from, source_sequence_to,
          tokens_before, tokens_after, summary_version, model_ref_json, created_at_ms,
          data_json, read_file_refs_json, changed_file_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 3, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.checkpointId,
        input.ownerRunId,
        input.sessionId,
        input.previousCheckpointId ?? null,
        input.ownerStepSequence,
        input.activationOperationId,
        input.coverage.coverageDigest,
        input.tokensBefore,
        input.tokensAfter,
        JSON.stringify(input.modelRef),
        input.createdAt,
        JSON.stringify(envelope),
        JSON.stringify(input.structuredCheckpoint.readFiles),
        JSON.stringify(input.structuredCheckpoint.changedFiles),
      );
  } catch (error) {
    throw new StorageError("Unable to persist immutable Context Checkpoint V3.", { cause: error });
  }
  return Object.freeze({ kind: "INSERTED" });
}

/** Compare the prepared Session coverage with the immutable Message V2 ledger in this transaction. */
function assertCoverageRowsInTransaction(
  database: CaelushDatabase,
  input: ContextCheckpointCreateInputV3,
): void {
  let coveredMessageCount = 0;
  const seenMessageIds = new Set<string>();
  for (const segment of input.coverage.segments) {
    const rows = database.client
      .prepare(
        `SELECT message_id, run_id, session_id, sequence, conversation_turn_id, audience_json
         FROM agent_messages
         WHERE run_id = ? AND sequence >= ? AND sequence <= ?
         ORDER BY sequence ASC`,
      )
      .all(segment.runId, segment.firstSequence, segment.lastSequence) as Array<{
      readonly message_id: string;
      readonly run_id: string;
      readonly session_id: string;
      readonly sequence: number;
      readonly conversation_turn_id: string;
      readonly audience_json: string;
    }>;
    if (rows.length !== segment.lastSequence - segment.firstSequence + 1) {
      throw new StorageConflictError("Context Checkpoint V3 source coverage is incomplete.");
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (
        row.run_id !== segment.runId ||
        row.session_id !== input.sessionId ||
        row.conversation_turn_id !== segment.conversationTurnId ||
        row.sequence !== segment.firstSequence + index ||
        (index === 0 && row.message_id !== segment.firstMessageId) ||
        (index === rows.length - 1 && row.message_id !== segment.lastMessageId) ||
        seenMessageIds.has(row.message_id)
      ) {
        throw new StorageConflictError("Context Checkpoint V3 source coverage has changed.");
      }
      let audience: unknown;
      try {
        audience = JSON.parse(row.audience_json) as unknown;
      } catch (error) {
        throw new StorageDecodeError("AgentMessageAudience", row.message_id, "agent_messages", {
          cause: error,
        });
      }
      if (
        audience === null ||
        typeof audience !== "object" ||
        Array.isArray(audience) ||
        (audience as Record<string, unknown>).model !== true
      ) {
        throw new StorageConflictError(
          "Context Checkpoint V3 includes a non-model-visible message.",
        );
      }
      seenMessageIds.add(row.message_id);
      coveredMessageCount += 1;
    }
  }
  if (coveredMessageCount !== input.coverage.messageCount) {
    throw new StorageConflictError("Context Checkpoint V3 source message count does not match.");
  }
}

function encodeCursor(cursor: CandidateCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CandidateCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !Number.isSafeInteger(parsed.ownerCreatedAtMs) ||
      typeof parsed.ownerRunId !== "string" ||
      !Number.isSafeInteger(parsed.ownerStepSequence) ||
      !Number.isSafeInteger(parsed.checkpointCreatedAtMs) ||
      typeof parsed.checkpointId !== "string" ||
      Object.keys(parsed).length !== 5
    ) {
      throw new TypeError("invalid cursor");
    }
    return parsed as unknown as CandidateCursor;
  } catch (error) {
    throw new StorageError("Context checkpoint cursor is invalid.", { cause: error });
  }
}

function cursorFromRow(row: CandidateRow): CandidateCursor {
  return {
    ownerCreatedAtMs: row.owner_created_at_ms,
    ownerRunId: row.run_id,
    ownerStepSequence: row.owner_step_sequence ?? 0,
    checkpointCreatedAtMs: row.created_at_ms,
    checkpointId: row.id,
  };
}
