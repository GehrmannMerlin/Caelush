import { createHash } from "node:crypto";
import {
  ArchiveDeletionSelectionSchema,
  RunIdSchema,
  RunStatusSchema,
  type ArchiveDeletionSelection,
  type ArchiveDeletionSnapshot,
  type RunId,
  type SessionId,
  type WorkspaceId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageArchiveConflictError } from "../errors.js";
import {
  archivedSessionItems,
  archivedWorkspaceItems,
  archiveState,
  readArchiveCatalog,
} from "./archive-query.js";

export interface ArchiveSelectionSet {
  readonly snapshot: ArchiveDeletionSnapshot;
  readonly workspaceIds: readonly WorkspaceId[];
  readonly sessionIds: readonly SessionId[];
  readonly runIds: readonly RunId[];
}

export function collectArchiveDeletionSnapshotInTransaction(
  database: CaelushDatabase,
  input: ArchiveDeletionSelection,
): ArchiveSelectionSet {
  const selection = ArchiveDeletionSelectionSchema.parse(input);
  const catalog = readArchiveCatalog(database);
  let workspaceIds: WorkspaceId[] = [];
  let sessionIds: SessionId[] = [];
  if (selection.type === "WORKSPACE" || selection.type === "SESSION") {
    if (!archiveState(catalog, selection).archived)
      throw new StorageArchiveConflictError(
        "ARCHIVE_SELECTION_CHANGED",
        "The object is no longer archived.",
      );
    if (selection.type === "WORKSPACE") workspaceIds = [selection.workspaceId];
    else sessionIds = [selection.sessionId];
  } else if (selection.type === "WORKSPACE_FILTER") {
    workspaceIds = archivedWorkspaceItems(catalog, selection.filter).map(
      (item) => item.workspace.id,
    );
  } else {
    sessionIds = archivedSessionItems(catalog, selection.filter).map((item) => item.sessionId);
  }
  const workspaces = new Set(workspaceIds);
  sessionIds = [
    ...new Set([
      ...sessionIds,
      ...catalog.sessions
        .filter((s) => s.workspaceId !== undefined && workspaces.has(s.workspaceId))
        .map((s) => s.id),
    ]),
  ].sort();
  workspaceIds.sort();
  const sessions = new Set(sessionIds);
  const runs = database.client
    .prepare("SELECT id, session_id, status, data_json FROM agent_runs ORDER BY id")
    .all()
    .flatMap((row) => {
      const runWorkspaceId: unknown = (
        JSON.parse(row.data_json as string) as { workspace?: { id?: unknown } }
      ).workspace?.id;
      const sessionId = row.session_id as SessionId;
      if (!sessions.has(sessionId)) {
        if (typeof runWorkspaceId === "string" && workspaces.has(runWorkspaceId as WorkspaceId))
          throw new StorageArchiveConflictError(
            "DATA_OWNERSHIP_CONFLICT",
            "A Run has conflicting Workspace ownership.",
          );
        return [];
      }
      const parent = catalog.sessionById.get(sessionId)?.workspaceId;
      if (parent !== undefined && parent !== runWorkspaceId)
        throw new StorageArchiveConflictError(
          "DATA_OWNERSHIP_CONFLICT",
          "A Run has conflicting Session ownership.",
        );
      return [
        {
          id: RunIdSchema.parse(row.id),
          sessionId,
          workspaceId: runWorkspaceId,
          status: RunStatusSchema.parse(row.status),
        },
      ];
    });
  const roots = workspaceIds.map((workspaceId) => ({
    workspaceId,
    archiveId: catalog.workspaceArchives.get(workspaceId)?.archiveId,
  }));
  const children = sessionIds.map((sessionId) => {
    const session = catalog.sessionById.get(sessionId)!;
    const state = archiveState(catalog, { type: "SESSION", sessionId });
    return {
      sessionId,
      workspaceId: session.workspaceId ?? null,
      archiveId: state.ownArchive?.archiveId ?? null,
      parentArchiveId: state.parentWorkspace?.archive?.archiveId ?? null,
    };
  });
  const samples: ArchiveDeletionSnapshot["samples"] =
    workspaceIds.length > 0
      ? workspaceIds.slice(0, 3).map((id) => {
          const w = catalog.workspaceById.get(id)!;
          return { type: "WORKSPACE", label: w.displayName, canonicalPath: w.canonicalPath };
        })
      : sessionIds
          .slice(0, 3)
          .map((id) => ({
            type: "SESSION",
            label: catalog.sessionById.get(id)?.title?.trim() || "未命名会话",
          }));
  return {
    workspaceIds,
    sessionIds,
    runIds: runs.map((r) => r.id),
    snapshot: {
      selection,
      digest: createHash("sha256")
        .update(JSON.stringify({ selection, roots, children, runs }))
        .digest("hex"),
      counts: { workspaces: workspaceIds.length, sessions: sessionIds.length, runs: runs.length },
      samples,
    },
  };
}
