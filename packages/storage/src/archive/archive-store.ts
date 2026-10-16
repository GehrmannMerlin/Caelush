import { randomUUID } from "node:crypto";
import {
  ArchiveTargetSchema,
  ArchiveSessionListQuerySchema,
  ArchiveWorkspaceListQuerySchema,
  type ArchiveDeletionSelection,
  type ArchiveDeletionSnapshot,
  RunStatusSchema,
  TimestampMsSchema,
  type AgentSession,
  type ArchiveMutationResponse,
  type ArchiveSessionListQuery,
  type ArchiveSessionListResponse,
  type ArchiveState,
  type ArchiveTarget,
  type ArchiveWorkspaceListQuery,
  type ArchiveWorkspaceListResponse,
  type RunStatus,
  type TimestampMs,
  type WorkspaceId,
  type WorkspaceRecord,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageArchiveConflictError, StorageError } from "../errors.js";
import {
  archivePage,
  archivedSessionItems,
  archivedWorkspaceItems,
  archiveState,
  readArchiveCatalog,
  type ArchiveCatalog,
} from "./archive-query.js";
import { archiveTransaction } from "./archive-transaction.js";
import { collectArchiveDeletionSnapshotInTransaction } from "./archive-selection.js";
import { purgeArchiveGraphInTransaction, type ArchiveDeletionCommit } from "./archive-purge.js";

export interface ArchivePolicy {
  readonly isTerminalRunStatus: (status: RunStatus) => boolean;
}
export interface ArchiveStore {
  snapshotDeletion(selection: ArchiveDeletionSelection): Promise<ArchiveDeletionSnapshot>;
  purge(
    selection: ArchiveDeletionSelection,
    expectedDigest: string,
  ): Promise<ArchiveDeletionCommit>;
  listSessions(query: ArchiveSessionListQuery): Promise<ArchiveSessionListResponse>;
  listWorkspaces(query: ArchiveWorkspaceListQuery): Promise<ArchiveWorkspaceListResponse>;
  getState(target: ArchiveTarget): Promise<ArchiveState>;
  archive(target: ArchiveTarget, at: TimestampMs): Promise<ArchiveMutationResponse>;
  restore(target: ArchiveTarget, expectedArchiveId: string): Promise<ArchiveMutationResponse>;
  listActiveSessions(input: { limit?: number; workspaceId?: WorkspaceId }): Promise<AgentSession[]>;
  listActiveWorkspaces(limit?: number): Promise<WorkspaceRecord[]>;
}

export function assertArchiveRunsTerminal(
  database: CaelushDatabase,
  target: ArchiveTarget,
  policy: ArchivePolicy | undefined,
): void {
  if (policy === undefined)
    throw new StorageError("Archive management requires a host Run status policy.");
  const rows =
    target.type === "SESSION"
      ? database.client
          .prepare("SELECT status FROM agent_runs WHERE session_id = ?")
          .all(target.sessionId)
      : database.client
          .prepare(
            "SELECT r.status FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id WHERE s.workspace_id = ?",
          )
          .all(target.workspaceId);
  if (rows.some((row) => !policy.isTerminalRunStatus(RunStatusSchema.parse(row.status))))
    throw new StorageArchiveConflictError(
      "ACTIVE_RUN_CONFLICT",
      "Please finish the active Run before archiving.",
    );
}

export function bumpArchiveRevision(database: CaelushDatabase): void {
  const changed = database.client
    .prepare(
      "UPDATE archive_catalog_meta SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991",
    )
    .run().changes;
  if (changed !== 1) throw new StorageError("The archive catalog revision could not be updated.");
}

export class SqliteArchiveStore implements ArchiveStore {
  constructor(
    private readonly database: CaelushDatabase,
    private readonly policy?: ArchivePolicy,
  ) {}

  async snapshotDeletion(selection: ArchiveDeletionSelection): Promise<ArchiveDeletionSnapshot> {
    return archiveTransaction(
      this.database,
      false,
      () => collectArchiveDeletionSnapshotInTransaction(this.database, selection).snapshot,
    );
  }

  async purge(
    selection: ArchiveDeletionSelection,
    expectedDigest: string,
  ): Promise<ArchiveDeletionCommit> {
    return archiveTransaction(this.database, true, () => {
      const set = collectArchiveDeletionSnapshotInTransaction(this.database, selection);
      if (set.snapshot.digest !== expectedDigest)
        throw new StorageArchiveConflictError(
          "ARCHIVE_SELECTION_CHANGED",
          "The deletion scope changed; review it again.",
        );
      for (const sessionId of set.sessionIds)
        assertArchiveRunsTerminal(this.database, { type: "SESSION", sessionId }, this.policy);
      if (this.policy === undefined)
        throw new StorageError("Archive management requires a host Run status policy.");
      return purgeArchiveGraphInTransaction(this.database, set);
    });
  }

  async getState(target: ArchiveTarget): Promise<ArchiveState> {
    const parsed = ArchiveTargetSchema.parse(target);
    return archiveTransaction(this.database, false, () =>
      archiveState(readArchiveCatalog(this.database), parsed),
    );
  }

  async listSessions(input: ArchiveSessionListQuery): Promise<ArchiveSessionListResponse> {
    const query = ArchiveSessionListQuerySchema.parse(input);
    return archiveTransaction(this.database, false, () => {
      const catalog = readArchiveCatalog(this.database);
      const filter = {
        query: query.query,
        workspaceId: query.workspaceId,
        unassociated: query.unassociated,
      };
      const items = archivedSessionItems(catalog, filter);
      return {
        ...archivePage(items, query, filter, catalog.revision, (item) => item.sessionId),
        matchedCount: items.length,
        totalCounts: {
          sessions: archivedSessionItems(catalog).length,
          workspaces: catalog.workspaceArchives.size,
        },
        catalogRevision: catalog.revision,
      };
    });
  }

  async listWorkspaces(input: ArchiveWorkspaceListQuery): Promise<ArchiveWorkspaceListResponse> {
    const query = ArchiveWorkspaceListQuerySchema.parse(input);
    return archiveTransaction(this.database, false, () => {
      const catalog = readArchiveCatalog(this.database);
      const filter = { query: query.query };
      const items = archivedWorkspaceItems(catalog, filter);
      return {
        ...archivePage(items, query, filter, catalog.revision, (item) => item.workspace.id),
        matchedCount: items.length,
        totalCounts: {
          sessions: archivedSessionItems(catalog).length,
          workspaces: catalog.workspaceArchives.size,
        },
        catalogRevision: catalog.revision,
      };
    });
  }

  async archive(input: ArchiveTarget, at: TimestampMs): Promise<ArchiveMutationResponse> {
    const target = ArchiveTargetSchema.parse(input);
    const time = TimestampMsSchema.parse(at);
    return this.mutate(target, (catalog) => {
      const state = archiveState(catalog, target);
      assertArchiveRunsTerminal(this.database, target, this.policy);
      if (state.archived) return false;
      if (target.type === "SESSION")
        this.database.client
          .prepare(
            "INSERT INTO session_archives (session_id, archive_id, archived_at_ms, reason) VALUES (?, ?, ?, 'USER')",
          )
          .run(target.sessionId, randomUUID(), time);
      else
        this.database.client
          .prepare(
            "INSERT INTO workspace_archives (workspace_id, archive_id, archived_at_ms, reason) VALUES (?, ?, ?, 'USER')",
          )
          .run(target.workspaceId, randomUUID(), time);
      return true;
    });
  }

  async restore(input: ArchiveTarget, expectedArchiveId: string): Promise<ArchiveMutationResponse> {
    const target = ArchiveTargetSchema.parse(input);
    return this.mutate(target, (catalog) => {
      const state = archiveState(catalog, target);
      if (!state.archived) return false;
      if (state.restoreDisposition === "PARENT_ARCHIVED")
        throw new StorageArchiveConflictError(
          "PARENT_WORKSPACE_ARCHIVED",
          "Restore the parent Workspace first.",
        );
      if (state.restoreDisposition === "WORKSPACE_UNAVAILABLE")
        throw new StorageArchiveConflictError(
          "WORKSPACE_UNAVAILABLE",
          "The original Workspace is unavailable.",
        );
      if (state.ownArchive?.archiveId !== expectedArchiveId)
        throw new StorageArchiveConflictError(
          "ARCHIVE_SELECTION_CHANGED",
          "The archive episode changed; refresh the list.",
        );
      if (this.policy === undefined)
        throw new StorageError("Archive management requires a host Run status policy.");
      if (target.type === "SESSION")
        this.database.client
          .prepare("DELETE FROM session_archives WHERE session_id = ? AND archive_id = ?")
          .run(target.sessionId, expectedArchiveId);
      else
        this.database.client
          .prepare("DELETE FROM workspace_archives WHERE workspace_id = ? AND archive_id = ?")
          .run(target.workspaceId, expectedArchiveId);
      return true;
    });
  }

  async listActiveSessions(input: {
    limit?: number;
    workspaceId?: WorkspaceId;
  }): Promise<AgentSession[]> {
    return archiveTransaction(this.database, false, () => {
      const catalog = readArchiveCatalog(this.database);
      return catalog.sessions
        .filter(
          (session) =>
            (input.workspaceId === undefined || input.workspaceId === session.workspaceId) &&
            !archiveState(catalog, { type: "SESSION", sessionId: session.id }).archived,
        )
        .slice(0, input.limit);
    });
  }

  async listActiveWorkspaces(limit?: number): Promise<WorkspaceRecord[]> {
    return archiveTransaction(this.database, false, () => {
      const catalog = readArchiveCatalog(this.database);
      return catalog.workspaces
        .filter((workspace) => !catalog.workspaceArchives.has(workspace.id))
        .slice(0, limit);
    });
  }

  private mutate(
    target: ArchiveTarget,
    change: (catalog: ArchiveCatalog) => boolean,
  ): ArchiveMutationResponse {
    return archiveTransaction(this.database, true, () => {
      const changed = change(readArchiveCatalog(this.database));
      if (changed) bumpArchiveRevision(this.database);
      const catalog = readArchiveCatalog(this.database);
      return { state: archiveState(catalog, target), changed, catalogRevision: catalog.revision };
    });
  }
}
