import { createHash } from "node:crypto";
import {
  ArchiveEpisodeSchema,
  ArchiveStateSchema,
  type AgentSession,
  type ArchiveEpisode,
  type ArchiveSessionFilter,
  type ArchiveSessionItem,
  type ArchiveState,
  type ArchiveTarget,
  type ArchiveWorkspaceFilter,
  type ArchiveWorkspaceItem,
  type SessionId,
  type WorkspaceId,
  type WorkspaceRecord,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeSession } from "../repositories/session-repository.js";
import { decodeWorkspace } from "../repositories/workspace-repository.js";
import { StorageArchiveConflictError, StorageError, StorageNotFoundError } from "../errors.js";

export interface ArchiveCatalog {
  readonly sessions: readonly AgentSession[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly sessionById: ReadonlyMap<SessionId, AgentSession>;
  readonly workspaceById: ReadonlyMap<WorkspaceId, WorkspaceRecord>;
  readonly sessionArchives: ReadonlyMap<SessionId, ArchiveEpisode>;
  readonly workspaceArchives: ReadonlyMap<WorkspaceId, ArchiveEpisode>;
  readonly revision: number;
}

export function archiveTransaction<T>(
  database: CaelushDatabase,
  write: boolean,
  operation: () => T,
): T {
  database.client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = operation();
    database.client.exec("COMMIT");
    return result;
  } catch (error) {
    database.client.exec("ROLLBACK");
    throw error;
  }
}

export function readArchiveCatalog(database: CaelushDatabase): ArchiveCatalog {
  const sessions = (
    database.client
      .prepare("SELECT * FROM agent_sessions ORDER BY updated_at_ms DESC, id ASC")
      .all() as unknown as Parameters<typeof decodeSession>[0][]
  ).map(decodeSession);
  const workspaces = (
    database.client
      .prepare(
        "SELECT * FROM workspaces ORDER BY last_opened_at_ms DESC, updated_at_ms DESC, id ASC",
      )
      .all() as unknown as Parameters<typeof decodeWorkspace>[0][]
  ).map(decodeWorkspace);
  const sessionArchives = new Map<SessionId, ArchiveEpisode>();
  const workspaceArchives = new Map<WorkspaceId, ArchiveEpisode>();
  for (const row of database.client.prepare("SELECT * FROM session_archives").all()) {
    sessionArchives.set(
      row.session_id as SessionId,
      ArchiveEpisodeSchema.parse({
        archiveId: row.archive_id,
        archivedAt: row.archived_at_ms,
        reason: row.reason,
      }),
    );
  }
  for (const row of database.client.prepare("SELECT * FROM workspace_archives").all()) {
    workspaceArchives.set(
      row.workspace_id as WorkspaceId,
      ArchiveEpisodeSchema.parse({
        archiveId: row.archive_id,
        archivedAt: row.archived_at_ms,
        reason: row.reason,
      }),
    );
  }
  const revision = database.client
    .prepare("SELECT revision FROM archive_catalog_meta WHERE singleton = 1")
    .get()?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new StorageError("The archive catalog revision is invalid.");
  return {
    sessions,
    workspaces,
    sessionById: new Map(sessions.map((s) => [s.id, s])),
    workspaceById: new Map(workspaces.map((w) => [w.id, w])),
    sessionArchives,
    workspaceArchives,
    revision,
  };
}

export function archiveState(catalog: ArchiveCatalog, target: ArchiveTarget): ArchiveState {
  if (target.type === "WORKSPACE") {
    if (!catalog.workspaceById.has(target.workspaceId))
      throw new StorageNotFoundError("Workspace", target.workspaceId);
    const ownArchive = catalog.workspaceArchives.get(target.workspaceId);
    return ArchiveStateSchema.parse({
      target,
      archived: ownArchive !== undefined,
      ...(ownArchive === undefined ? {} : { ownArchive }),
      restoreDisposition: ownArchive === undefined ? "NOT_ARCHIVED" : "AVAILABLE",
    });
  }
  const session = catalog.sessionById.get(target.sessionId);
  if (session === undefined) throw new StorageNotFoundError("AgentSession", target.sessionId);
  const ownArchive = catalog.sessionArchives.get(session.id);
  const workspace =
    session.workspaceId === undefined ? undefined : catalog.workspaceById.get(session.workspaceId);
  const parentArchive =
    session.workspaceId === undefined
      ? undefined
      : catalog.workspaceArchives.get(session.workspaceId);
  const archived = ownArchive !== undefined || parentArchive !== undefined;
  return ArchiveStateSchema.parse({
    target,
    archived,
    ...(ownArchive === undefined ? {} : { ownArchive }),
    ...(session.workspaceId === undefined
      ? {}
      : {
          parentWorkspace: {
            workspaceId: session.workspaceId,
            ...(parentArchive === undefined ? {} : { archive: parentArchive }),
          },
        }),
    restoreDisposition: !archived
      ? "NOT_ARCHIVED"
      : parentArchive !== undefined
        ? "PARENT_ARCHIVED"
        : workspace === undefined
          ? "WORKSPACE_UNAVAILABLE"
          : "AVAILABLE",
  });
}

export function normalizedArchiveText(text: string): string {
  return text.normalize("NFC").toLowerCase();
}
function matches(text: string, query: string | undefined): boolean {
  return query === undefined || normalizedArchiveText(text).includes(normalizedArchiveText(query));
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareTime(a: number | null, b: number | null): number {
  return a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
}

export function archivedSessionItems(
  catalog: ArchiveCatalog,
  filter: ArchiveSessionFilter = {},
): ArchiveSessionItem[] {
  const items: ArchiveSessionItem[] = [];
  for (const session of catalog.sessions) {
    const state = archiveState(catalog, { type: "SESSION", sessionId: session.id });
    if (!state.archived) continue;
    const workspace =
      session.workspaceId === undefined
        ? undefined
        : catalog.workspaceById.get(session.workspaceId);
    const title = session.title?.trim() || "未命名会话";
    if (
      !matches(title, filter.query) ||
      (filter.workspaceId !== undefined && session.workspaceId !== filter.workspaceId) ||
      (filter.unassociated === true && workspace !== undefined)
    )
      continue;
    items.push({
      sessionId: session.id,
      title,
      state,
      archivedAt:
        state.ownArchive !== undefined
          ? state.ownArchive.archivedAt
          : (state.parentWorkspace?.archive?.archivedAt ?? null),
      group:
        workspace === undefined
          ? { key: "UNASSOCIATED", displayName: "未关联工作区", matchedCount: 0 }
          : {
              key: workspace.id,
              displayName: workspace.displayName,
              workspaceId: workspace.id,
              canonicalPath: workspace.canonicalPath,
              matchedCount: 0,
            },
    });
  }
  const groupCounts = new Map<string, number>();
  for (const item of items)
    groupCounts.set(item.group.key, (groupCounts.get(item.group.key) ?? 0) + 1);
  for (const item of items) item.group.matchedCount = groupCounts.get(item.group.key)!;
  return items.sort(
    (a, b) =>
      Number(a.group.key === "UNASSOCIATED") - Number(b.group.key === "UNASSOCIATED") ||
      compare(
        normalizedArchiveText(a.group.displayName),
        normalizedArchiveText(b.group.displayName),
      ) ||
      compare(a.group.key, b.group.key) ||
      compareTime(a.archivedAt, b.archivedAt) ||
      compare(a.sessionId, b.sessionId),
  );
}

export function archivedWorkspaceItems(
  catalog: ArchiveCatalog,
  filter: ArchiveWorkspaceFilter = {},
): ArchiveWorkspaceItem[] {
  const counts = new Map<WorkspaceId, number>();
  for (const session of catalog.sessions)
    if (session.workspaceId !== undefined)
      counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1);
  return catalog.workspaces
    .filter(
      (w) =>
        catalog.workspaceArchives.has(w.id) &&
        (matches(w.displayName, filter.query) || matches(w.canonicalPath, filter.query)),
    )
    .map((workspace) => ({
      workspace,
      state: archiveState(catalog, { type: "WORKSPACE" as const, workspaceId: workspace.id }),
      archivedAt: catalog.workspaceArchives.get(workspace.id)!.archivedAt,
      sessionCount: counts.get(workspace.id) ?? 0,
    }))
    .sort(
      (a, b) => compareTime(a.archivedAt, b.archivedAt) || compare(a.workspace.id, b.workspace.id),
    );
}

export function archivePage<T>(
  items: readonly T[],
  query: { limit: number; cursor?: string | undefined },
  filter: unknown,
  revision: number,
  id: (item: T) => string,
): { items: T[]; nextCursor?: string } {
  const fingerprint = createHash("sha256").update(JSON.stringify(filter)).digest("hex");
  let offset = 0;
  if (query.cursor !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    } catch {
      throw new StorageArchiveConflictError("INVALID_REQUEST", "The archive cursor is invalid.");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("revision" in value) ||
      !("fingerprint" in value) ||
      !("lastId" in value) ||
      typeof value.lastId !== "string"
    )
      throw new StorageArchiveConflictError("INVALID_REQUEST", "The archive cursor is invalid.");
    if (value.revision !== revision || value.fingerprint !== fingerprint)
      throw new StorageArchiveConflictError(
        "ARCHIVE_LIST_CHANGED",
        "The archive list changed; refresh the list.",
      );
    const last = items.findIndex((item) => id(item) === value.lastId);
    if (last < 0)
      throw new StorageArchiveConflictError(
        "ARCHIVE_LIST_CHANGED",
        "The archive list changed; refresh the list.",
      );
    offset = last + 1;
  }
  const page = items.slice(offset, offset + query.limit);
  return {
    items: page,
    ...(offset + page.length < items.length
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ revision, fingerprint, lastId: id(page.at(-1)!) }),
          ).toString("base64url"),
        }
      : {}),
  };
}
