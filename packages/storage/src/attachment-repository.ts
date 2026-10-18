import {
  AttachmentDescriptorSchema,
  AttachmentDraftSchema,
  AttachmentIdSchema,
  AttachmentIdsSchema,
  AttachmentOwnerSchema,
  AttachmentRecoveryRecordSchema,
  AttachmentStatusSchema,
  PendingAttachmentSchema,
  SessionIdSchema,
  SubmissionIdSchema,
  VerifiedAttachmentMetadataSchema,
  WorkspaceIdSchema,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type AttachmentDescriptor,
  type AttachmentDraft,
  type AttachmentId,
  type AttachmentOwner,
  type AttachmentRecoveryRecord,
  type PendingAttachment,
  type SessionId,
  type SubmissionId,
  type VerifiedAttachmentMetadata,
  type WorkspaceId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import {
  withArchiveWriteTransaction,
  assertArchiveWritableInTransaction,
} from "./archive/archive-write-guard.js";
import { StorageConflictError, StorageNotFoundError } from "./errors.js";

interface AttachmentRow {
  artifact_id: string;
  workspace_id: string;
  owner_kind: "WORKSPACE" | "SESSION";
  owner_id: string;
  name: string;
  declared_media_type: string;
  media_type: string | null;
  byte_length: number | null;
  sha256: string | null;
  status: string;
  visual_requirement: string;
  processor_version: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AttachmentDraftInput {
  readonly text: string;
  readonly artifactIds: readonly AttachmentId[];
  readonly submissionId?: SubmissionId;
}

export interface AttachmentRepository {
  createPending(input: PendingAttachment): Promise<void>;
  markPreprocessing(id: AttachmentId): Promise<void>;
  markReady(
    id: AttachmentId,
    verifiedMetadata: VerifiedAttachmentMetadata,
  ): Promise<AttachmentDescriptor>;
  markFailed(id: AttachmentId): Promise<void>;
  markUnavailable(id: AttachmentId): Promise<void>;
  getAuthorized(id: AttachmentId, owner: AttachmentOwner): Promise<AttachmentDescriptor | null>;
  attachToMessage(
    ids: readonly AttachmentId[],
    messageId: string,
    owner: AttachmentOwner,
  ): Promise<void>;
  saveDraft(
    owner: AttachmentOwner,
    expectedRevision: number,
    draft: AttachmentDraftInput,
  ): Promise<AttachmentDraft>;
  getDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null>;
  removeDraftReference(owner: AttachmentOwner, id: AttachmentId): Promise<void>;
  listUnreferenced(before: number): Promise<AttachmentId[]>;
  deleteUnreferenced(id: AttachmentId, before: number): Promise<boolean>;
  listForRecovery(): Promise<AttachmentRecoveryRecord[]>;
}

export class SqliteAttachmentRepository implements AttachmentRepository {
  constructor(
    private readonly database: CaelushDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async createPending(input: PendingAttachment): Promise<void> {
    const attachment = PendingAttachmentSchema.parse(input);
    withArchiveWriteTransaction(this.database, () => {
      const workspaceId = this.requireOwnerWorkspace(attachment.owner);
      if (workspaceId !== attachment.workspaceId) {
        throw new StorageNotFoundError("Attachment owner", attachment.owner.kind);
      }
      assertArchiveWritableInTransaction(this.database, this.archiveTarget(attachment.owner));
      try {
        this.database.client
          .prepare(
            `INSERT INTO attachments
              (artifact_id, workspace_id, owner_kind, owner_id, name, declared_media_type,
               media_type, byte_length, sha256, status, visual_requirement, processor_version,
               created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'UPLOADING', 'UNKNOWN', NULL, ?, ?)`,
          )
          .run(
            attachment.artifactId,
            attachment.workspaceId,
            attachment.owner.kind,
            this.ownerId(attachment.owner),
            attachment.name,
            attachment.declaredMediaType,
            attachment.createdAt,
            attachment.createdAt,
          );
      } catch (error) {
        if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) {
          throw new StorageConflictError("Attachment ID already exists.", { cause: error });
        }
        throw error;
      }
    });
  }

  async markReady(
    id: AttachmentId,
    verifiedMetadata: VerifiedAttachmentMetadata,
  ): Promise<AttachmentDescriptor> {
    const artifactId = AttachmentIdSchema.parse(id);
    const metadata = VerifiedAttachmentMetadataSchema.parse(verifiedMetadata);
    return withArchiveWriteTransaction(this.database, () => {
      const row = this.readRow(artifactId);
      if (row === null) throw new StorageNotFoundError("Attachment", artifactId);
      assertArchiveWritableInTransaction(this.database, this.archiveTargetFromRow(row));
      if (row.status === "READY") {
        if (!this.matchesReadyMetadata(row, metadata)) {
          throw new StorageConflictError("Ready attachment metadata is immutable.");
        }
        return this.toDescriptor(row);
      }
      if (row.status !== "UPLOADING" && row.status !== "PREPROCESSING") {
        throw new StorageConflictError(
          "Attachment cannot transition to READY from its current state.",
        );
      }
      this.database.client
        .prepare(
          `UPDATE attachments
           SET media_type = ?, byte_length = ?, sha256 = ?, status = 'READY', visual_requirement = ?,
               processor_version = ?, updated_at_ms = ?
           WHERE artifact_id = ? AND status IN ('UPLOADING', 'PREPROCESSING')`,
        )
        .run(
          metadata.mediaType,
          metadata.byteLength,
          metadata.sha256,
          metadata.visualRequirement,
          metadata.processorVersion,
          this.now(),
          artifactId,
        );
      const updated = this.readRow(artifactId);
      if (updated === null) throw new StorageNotFoundError("Attachment", artifactId);
      return this.toDescriptor(updated);
    });
  }

  async markFailed(id: AttachmentId): Promise<void> {
    this.transition(id, "FAILED");
  }

  async markPreprocessing(id: AttachmentId): Promise<void> {
    const artifactId = AttachmentIdSchema.parse(id);
    withArchiveWriteTransaction(this.database, () => {
      const row = this.readRow(artifactId);
      if (row === null) throw new StorageNotFoundError("Attachment", artifactId);
      assertArchiveWritableInTransaction(this.database, this.archiveTargetFromRow(row));
      if (row.status === "PREPROCESSING") return;
      if (row.status !== "UPLOADING") {
        throw new StorageConflictError(
          "Attachment cannot enter PREPROCESSING from its current state.",
        );
      }
      this.database.client
        .prepare(
          "UPDATE attachments SET status = 'PREPROCESSING', updated_at_ms = ? WHERE artifact_id = ?",
        )
        .run(this.now(), artifactId);
    });
  }

  async markUnavailable(id: AttachmentId): Promise<void> {
    this.transition(id, "UNAVAILABLE");
  }

  async getAuthorized(
    id: AttachmentId,
    owner: AttachmentOwner,
  ): Promise<AttachmentDescriptor | null> {
    const artifactId = AttachmentIdSchema.parse(id);
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const row = this.readRow(artifactId);
    if (row === null || row.status !== "READY" || !this.canRead(row, parsedOwner)) return null;
    return this.toDescriptor(row);
  }

  async attachToMessage(
    ids: readonly AttachmentId[],
    messageId: string,
    owner: AttachmentOwner,
  ): Promise<void> {
    const artifactIds = AttachmentIdsSchema.parse(ids);
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    withArchiveWriteTransaction(this.database, () => {
      const message = this.database.client
        .prepare(
          `SELECT m.session_id, m.message_type, s.workspace_id
           FROM agent_messages AS m
           JOIN agent_sessions AS s ON s.id = m.session_id
           WHERE m.message_id = ?`,
        )
        .get(messageId) as
        { session_id: string; message_type: string; workspace_id: string | null } | undefined;
      if (message === undefined || message.message_type !== "USER") {
        throw new StorageNotFoundError("User message", messageId);
      }
      const sessionId = SessionIdSchema.parse(message.session_id);
      const messageWorkspace = this.sessionWorkspace(sessionId);
      if (messageWorkspace === null) throw new StorageNotFoundError("Workspace", sessionId);
      if (
        (parsedOwner.kind === "SESSION" && parsedOwner.sessionId !== sessionId) ||
        (parsedOwner.kind === "WORKSPACE" && parsedOwner.workspaceId !== messageWorkspace)
      ) {
        throw new StorageNotFoundError("Attachment owner", this.ownerId(parsedOwner));
      }
      assertArchiveWritableInTransaction(this.database, {
        type: "SESSION",
        sessionId,
      });

      const insert = this.database.client.prepare(
        `INSERT OR IGNORE INTO attachment_references
          (artifact_id, reference_kind, reference_id, owner_kind, owner_id, ordinal, created_at_ms)
         VALUES (?, 'MESSAGE', ?, 'SESSION', ?, ?, ?)`,
      );
      let totalBytes = 0;
      artifactIds.forEach((artifactId, ordinal) => {
        const row = this.readRow(artifactId);
        if (
          row === null ||
          row.status !== "READY" ||
          row.workspace_id !== messageWorkspace ||
          !this.ownerCanReference(row, parsedOwner, messageWorkspace)
        ) {
          throw new StorageNotFoundError("Attachment", artifactId);
        }
        totalBytes += row.byte_length ?? 0;
        if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
          throw new StorageConflictError("Message attachments exceed the byte limit.");
        }
        insert.run(artifactId, messageId, sessionId, ordinal, this.now());
      });
    });
  }

  async saveDraft(
    owner: AttachmentOwner,
    expectedRevision: number,
    draft: AttachmentDraftInput,
  ): Promise<AttachmentDraft> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StorageConflictError("Draft revision is invalid.");
    }
    const text = typeof draft.text === "string" ? draft.text : "";
    if (text.length > 200_000) throw new StorageConflictError("Draft text exceeds its limit.");
    const artifactIds = AttachmentDraftIdListSchema.parse(draft.artifactIds);
    const submissionId =
      draft.submissionId === undefined ? undefined : SubmissionIdSchema.parse(draft.submissionId);
    withArchiveWriteTransaction(this.database, () => {
      const workspaceId = this.requireOwnerWorkspace(parsedOwner);
      assertArchiveWritableInTransaction(this.database, this.archiveTarget(parsedOwner));
      const ownerId = this.ownerId(parsedOwner);
      const current = this.database.client
        .prepare(`SELECT revision FROM attachment_drafts WHERE owner_kind = ? AND owner_id = ?`)
        .get(parsedOwner.kind, ownerId) as { revision: number } | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new StorageConflictError("Draft revision changed; reload before saving.");
      }
      let totalBytes = 0;
      for (const artifactId of artifactIds) {
        const row = this.readRow(artifactId);
        if (
          row === null ||
          row.status !== "READY" ||
          !this.ownerCanReference(row, parsedOwner, workspaceId)
        ) {
          throw new StorageNotFoundError("Attachment", artifactId);
        }
        totalBytes += row.byte_length ?? 0;
      }
      if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new StorageConflictError("Draft attachments exceed the message byte limit.");
      }
      const revision = expectedRevision + 1;
      const referenceId = this.draftReferenceId(parsedOwner);
      this.database.client
        .prepare(
          `DELETE FROM attachment_references
           WHERE reference_kind = 'DRAFT' AND owner_kind = ? AND owner_id = ?`,
        )
        .run(parsedOwner.kind, ownerId);
      const insertReference = this.database.client.prepare(
        `INSERT INTO attachment_references
          (artifact_id, reference_kind, reference_id, owner_kind, owner_id, ordinal, created_at_ms)
         VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)`,
      );
      artifactIds.forEach((artifactId, ordinal) =>
        insertReference.run(
          artifactId,
          referenceId,
          parsedOwner.kind,
          ownerId,
          ordinal,
          this.now(),
        ),
      );
      this.database.client
        .prepare(
          `INSERT INTO attachment_drafts (owner_kind, owner_id, revision, text, submission_id, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
             revision = excluded.revision,
             text = excluded.text,
             submission_id = excluded.submission_id,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(parsedOwner.kind, ownerId, revision, text, submissionId ?? null, this.now());
    });
    return (await this.getDraft(parsedOwner))!;
  }

  async getDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const ownerId = this.ownerId(parsedOwner);
    const row = this.database.client
      .prepare(
        `SELECT revision, text, submission_id FROM attachment_drafts WHERE owner_kind = ? AND owner_id = ?`,
      )
      .get(parsedOwner.kind, ownerId) as
      { revision: number; text: string; submission_id: string | null } | undefined;
    if (row === undefined) return null;
    const refs = this.database.client
      .prepare(
        `SELECT artifact_id FROM attachment_references
         WHERE reference_kind = 'DRAFT' AND owner_kind = ? AND owner_id = ? ORDER BY ordinal ASC`,
      )
      .all(parsedOwner.kind, ownerId) as Array<{ artifact_id: string }>;
    return AttachmentDraftSchema.parse({
      owner: parsedOwner,
      revision: row.revision,
      text: row.text,
      artifactIds: refs.map((reference) => AttachmentIdSchema.parse(reference.artifact_id)),
      ...(row.submission_id === null ? {} : { submissionId: row.submission_id }),
    });
  }

  async removeDraftReference(owner: AttachmentOwner, id: AttachmentId): Promise<void> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const artifactId = AttachmentIdSchema.parse(id);
    withArchiveWriteTransaction(this.database, () => {
      this.requireOwnerWorkspace(parsedOwner);
      assertArchiveWritableInTransaction(this.database, this.archiveTarget(parsedOwner));
      const ownerId = this.ownerId(parsedOwner);
      const result = this.database.client
        .prepare(
          `DELETE FROM attachment_references
           WHERE artifact_id = ? AND reference_kind = 'DRAFT' AND owner_kind = ? AND owner_id = ?`,
        )
        .run(artifactId, parsedOwner.kind, ownerId);
      if (result.changes === 0) return;
      this.database.client
        .prepare(
          `UPDATE attachment_drafts SET revision = revision + 1, submission_id = NULL, updated_at_ms = ?
           WHERE owner_kind = ? AND owner_id = ?`,
        )
        .run(this.now(), parsedOwner.kind, ownerId);
    });
  }

  async listUnreferenced(before: number): Promise<AttachmentId[]> {
    if (!Number.isSafeInteger(before) || before < 0) return [];
    const rows = this.database.client
      .prepare(
        `SELECT a.artifact_id FROM attachments AS a
         WHERE a.created_at_ms < ?
           AND NOT EXISTS (
             SELECT 1 FROM attachment_references AS r WHERE r.artifact_id = a.artifact_id
           )
         ORDER BY a.created_at_ms ASC, a.artifact_id ASC`,
      )
      .all(before) as Array<{ artifact_id: string }>;
    return rows.map((row) => AttachmentIdSchema.parse(row.artifact_id));
  }

  async deleteUnreferenced(id: AttachmentId, before: number): Promise<boolean> {
    const artifactId = AttachmentIdSchema.parse(id);
    if (!Number.isSafeInteger(before) || before < 0) return false;
    return withArchiveWriteTransaction(this.database, () => {
      const result = this.database.client
        .prepare(
          `DELETE FROM attachments
           WHERE artifact_id = ? AND created_at_ms < ?
             AND NOT EXISTS (
               SELECT 1 FROM attachment_references AS r WHERE r.artifact_id = attachments.artifact_id
             )`,
        )
        .run(artifactId, before);
      return result.changes === 1;
    });
  }

  async listForRecovery(): Promise<AttachmentRecoveryRecord[]> {
    const rows = this.database.client
      .prepare(
        "SELECT artifact_id, status, byte_length, sha256 FROM attachments ORDER BY artifact_id",
      )
      .all() as Array<{
      artifact_id: string;
      status: string;
      byte_length: number | null;
      sha256: string | null;
    }>;
    return rows.map((row) =>
      AttachmentRecoveryRecordSchema.parse({
        artifactId: row.artifact_id,
        status: row.status,
        ...(row.byte_length === null ? {} : { byteLength: row.byte_length }),
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
      }),
    );
  }

  private transition(id: AttachmentId, status: "FAILED" | "UNAVAILABLE"): void {
    const artifactId = AttachmentIdSchema.parse(id);
    withArchiveWriteTransaction(this.database, () => {
      const row = this.readRow(artifactId);
      if (row === null) throw new StorageNotFoundError("Attachment", artifactId);
      assertArchiveWritableInTransaction(this.database, this.archiveTargetFromRow(row));
      if (row.status === "READY" && status === "FAILED")
        throw new StorageConflictError("A READY attachment cannot be downgraded.");
      if (row.status === status) return;
      this.database.client
        .prepare("UPDATE attachments SET status = ?, updated_at_ms = ? WHERE artifact_id = ?")
        .run(status, this.now(), artifactId);
    });
  }

  private canRead(row: AttachmentRow, owner: AttachmentOwner): boolean {
    if (owner.kind === "WORKSPACE") {
      return row.owner_kind === "WORKSPACE" && row.owner_id === owner.workspaceId;
    }
    const sessionWorkspaceId = this.sessionWorkspace(owner.sessionId);
    if (sessionWorkspaceId === null || row.workspace_id !== sessionWorkspaceId) return false;
    if (row.owner_kind === "SESSION" && row.owner_id === owner.sessionId) return true;
    if (row.owner_kind !== "WORKSPACE") return false;
    return (
      this.database.client
        .prepare(
          `SELECT 1 FROM attachment_references
           WHERE artifact_id = ? AND owner_kind = 'SESSION' AND owner_id = ? LIMIT 1`,
        )
        .get(row.artifact_id, owner.sessionId) !== undefined
    );
  }

  private ownerCanReference(
    row: AttachmentRow,
    owner: AttachmentOwner,
    workspaceId: WorkspaceId,
  ): boolean {
    if (row.workspace_id !== workspaceId) return false;
    if (owner.kind === "WORKSPACE") {
      return row.owner_kind === "WORKSPACE" && row.owner_id === owner.workspaceId;
    }
    return (
      (row.owner_kind === "SESSION" && row.owner_id === owner.sessionId) ||
      (row.owner_kind === "WORKSPACE" && row.owner_id === workspaceId)
    );
  }

  private requireOwnerWorkspace(owner: AttachmentOwner): WorkspaceId {
    if (owner.kind === "WORKSPACE") {
      const exists = this.database.client
        .prepare("SELECT 1 FROM workspaces WHERE id = ?")
        .get(owner.workspaceId);
      if (exists === undefined) throw new StorageNotFoundError("Workspace", owner.workspaceId);
      return owner.workspaceId;
    }
    const workspaceId = this.sessionWorkspace(owner.sessionId);
    if (workspaceId === null) throw new StorageNotFoundError("Session Workspace", owner.sessionId);
    return workspaceId;
  }

  private sessionWorkspace(sessionId: SessionId): WorkspaceId | null {
    const row = this.database.client
      .prepare("SELECT workspace_id FROM agent_sessions WHERE id = ?")
      .get(sessionId) as { workspace_id: string | null } | undefined;
    return row?.workspace_id === null || row === undefined
      ? null
      : WorkspaceIdSchema.parse(row.workspace_id);
  }

  private archiveTarget(owner: AttachmentOwner) {
    return owner.kind === "WORKSPACE"
      ? { type: "WORKSPACE" as const, workspaceId: owner.workspaceId }
      : { type: "SESSION" as const, sessionId: owner.sessionId };
  }

  private archiveTargetFromRow(row: AttachmentRow) {
    return row.owner_kind === "WORKSPACE"
      ? { type: "WORKSPACE" as const, workspaceId: WorkspaceIdSchema.parse(row.workspace_id) }
      : { type: "SESSION" as const, sessionId: SessionIdSchema.parse(row.owner_id) };
  }

  private ownerId(owner: AttachmentOwner): string {
    return owner.kind === "WORKSPACE" ? owner.workspaceId : owner.sessionId;
  }

  private draftReferenceId(owner: AttachmentOwner): string {
    return `${owner.kind}:${this.ownerId(owner)}`;
  }

  private readRow(id: AttachmentId): AttachmentRow | null {
    return (
      (this.database.client
        .prepare(
          `SELECT artifact_id, workspace_id, owner_kind, owner_id, name, declared_media_type,
                  media_type, byte_length, sha256, status, visual_requirement, processor_version,
                  created_at_ms, updated_at_ms
           FROM attachments WHERE artifact_id = ?`,
        )
        .get(id) as AttachmentRow | undefined) ?? null
    );
  }

  private toDescriptor(row: AttachmentRow): AttachmentDescriptor {
    if (
      row.status !== "READY" ||
      row.media_type === null ||
      row.byte_length === null ||
      row.sha256 === null ||
      row.processor_version === null
    ) {
      throw new StorageConflictError("Attachment is not READY.");
    }
    return AttachmentDescriptorSchema.parse({
      artifactId: row.artifact_id,
      workspaceId: row.workspace_id,
      name: row.name,
      mediaType: row.media_type,
      byteLength: row.byte_length,
      sha256: row.sha256,
      status: AttachmentStatusSchema.parse(row.status),
      visualRequirement: row.visual_requirement,
      processorVersion: row.processor_version,
    });
  }

  private matchesReadyMetadata(row: AttachmentRow, metadata: VerifiedAttachmentMetadata): boolean {
    return (
      row.media_type === metadata.mediaType &&
      row.byte_length === metadata.byteLength &&
      row.sha256 === metadata.sha256 &&
      row.visual_requirement === metadata.visualRequirement &&
      row.processor_version === metadata.processorVersion
    );
  }
}

const AttachmentDraftIdListSchema = AttachmentDraftSchema.shape.artifactIds;
