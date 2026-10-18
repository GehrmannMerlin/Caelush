import {
  AttachmentSha256Schema,
  SubmissionIdSchema,
  SubmissionRecordSchema,
  createTimestampMs,
  SessionIdSchema,
  type RunId,
  type SessionId,
  type SubmissionId,
  type SubmissionRecord,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { archiveTransaction } from "./archive/archive-transaction.js";
import { StorageConflictError, StorageNotFoundError } from "./errors.js";

interface SubmissionRow {
  submission_id: string;
  payload_hash: string;
  session_id: string | null;
  run_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SubmissionRepository {
  reserve(submissionId: SubmissionId, payloadHash: string): Promise<SubmissionRecord>;
  bindSession(submissionId: SubmissionId, sessionId: SessionId): Promise<void>;
  bindRun(submissionId: SubmissionId, runId: RunId): Promise<void>;
  get(submissionId: SubmissionId): Promise<SubmissionRecord | null>;
}

export class SqliteSubmissionRepository implements SubmissionRepository {
  constructor(
    private readonly database: CaelushDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(submissionId: SubmissionId, payloadHash: string): Promise<SubmissionRecord> {
    const id = SubmissionIdSchema.parse(submissionId);
    const hash = AttachmentSha256Schema.parse(payloadHash);
    return archiveTransaction(this.database, true, () => {
      const existing = this.readRow(id);
      if (existing !== null) {
        if (existing.payload_hash !== hash) {
          throw new StorageConflictError("Submission ID was already used for a different payload.");
        }
        return this.toRecord(existing);
      }
      const timestamp = this.now();
      this.database.client
        .prepare(
          `INSERT INTO submissions (submission_id, payload_hash, session_id, run_id, created_at_ms, updated_at_ms)
           VALUES (?, ?, NULL, NULL, ?, ?)`,
        )
        .run(id, hash, timestamp, timestamp);
      const created = this.readRow(id);
      if (created === null) throw new StorageNotFoundError("Submission", id);
      return this.toRecord(created);
    });
  }

  async bindSession(submissionId: SubmissionId, sessionId: SessionId): Promise<void> {
    return archiveTransaction(this.database, true, () => {
      bindSubmissionSessionInTransaction(this.database, submissionId, sessionId, this.now());
    });
  }

  async bindRun(submissionId: SubmissionId, runId: RunId): Promise<void> {
    return archiveTransaction(this.database, true, () => {
      bindSubmissionRunInTransaction(this.database, submissionId, runId, this.now());
    });
  }

  async get(submissionId: SubmissionId): Promise<SubmissionRecord | null> {
    const row = this.readRow(SubmissionIdSchema.parse(submissionId));
    return row === null ? null : this.toRecord(row);
  }

  private readRow(id: SubmissionId): SubmissionRow | null {
    return (
      (this.database.client
        .prepare(
          `SELECT submission_id, payload_hash, session_id, run_id, created_at_ms, updated_at_ms
           FROM submissions WHERE submission_id = ?`,
        )
        .get(id) as SubmissionRow | undefined) ?? null
    );
  }

  private toRecord(row: SubmissionRow): SubmissionRecord {
    return SubmissionRecordSchema.parse({
      submissionId: row.submission_id,
      payloadHash: row.payload_hash,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      createdAt: createTimestampMs(row.created_at_ms),
      updatedAt: createTimestampMs(row.updated_at_ms),
    });
  }
}

/** Bind a new Session while its insert transaction is still open. */
export function bindSubmissionSessionInTransaction(
  database: CaelushDatabase,
  submissionId: SubmissionId,
  sessionId: SessionId,
  now = Date.now(),
): void {
  const row = database.client
    .prepare("SELECT session_id FROM submissions WHERE submission_id = ?")
    .get(submissionId) as { session_id: string | null } | undefined;
  if (row === undefined) throw new StorageNotFoundError("Submission", submissionId);
  if (row.session_id !== null && row.session_id !== sessionId) {
    throw new StorageConflictError("Submission is already bound to another Session.");
  }
  database.client
    .prepare("UPDATE submissions SET session_id = ?, updated_at_ms = ? WHERE submission_id = ?")
    .run(sessionId, now, submissionId);
}

/** Bind a new Run in the same authoritative transaction that inserts the Run and its Events. */
export function bindSubmissionRunInTransaction(
  database: CaelushDatabase,
  submissionId: SubmissionId,
  runId: RunId,
  now = Date.now(),
): void {
  const row = database.client
    .prepare("SELECT session_id, run_id FROM submissions WHERE submission_id = ?")
    .get(submissionId) as { session_id: string | null; run_id: string | null } | undefined;
  if (row === undefined) throw new StorageNotFoundError("Submission", submissionId);
  const run = database.client
    .prepare("SELECT session_id FROM agent_runs WHERE id = ?")
    .get(runId) as { session_id: string } | undefined;
  if (run === undefined) throw new StorageNotFoundError("Run", runId);
  const runSessionId = SessionIdSchema.parse(run.session_id);
  if (row.session_id !== null && row.session_id !== runSessionId) {
    throw new StorageConflictError("Submission is already bound to another Session.");
  }
  if (row.run_id !== null && row.run_id !== runId) {
    throw new StorageConflictError("Submission is already bound to another Run.");
  }
  database.client
    .prepare(
      "UPDATE submissions SET session_id = ?, run_id = ?, updated_at_ms = ? WHERE submission_id = ?",
    )
    .run(runSessionId, runId, now, submissionId);
}
