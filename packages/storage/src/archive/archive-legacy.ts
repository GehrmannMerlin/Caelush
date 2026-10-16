import { createHash, randomUUID } from "node:crypto";
import {
  LegacyArchiveImportRequestSchema,
  RunStatusSchema,
  SessionIdSchema,
  WorkspaceRecordSchema,
  WorkspaceRefSchema,
  type AgentSession,
  type LegacyArchiveImportRequest,
  type LegacyArchiveImportResponse,
  type SessionId,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageError } from "../errors.js";
import { readArchiveCatalog, archiveState, isUnassociatedLegacySession } from "./archive-query.js";
import type { ArchivePolicy } from "./archive-store.js";

export interface LegacyArchiveCandidate {
  readonly session: AgentSession;
  readonly runWorkspaces: readonly WorkspaceRef[];
  readonly ambiguous: boolean;
  readonly hasNonTerminalRun: boolean;
  readonly evidenceDigest: string;
}
export interface LegacyArchiveEntry {
  readonly sessionId: SessionId;
  readonly expectedEvidenceDigest: string;
  readonly workspace?: WorkspaceRecord;
}
export interface LegacyArchiveReconcileResult {
  readonly migratedSessionIds: readonly SessionId[];
  readonly deferredSessionIds: readonly SessionId[];
  readonly catalogRevision: number;
}

function requirePolicy(policy: ArchivePolicy | undefined): ArchivePolicy {
  if (policy === undefined)
    throw new StorageError("Archive management requires a host Run status policy.");
  return policy;
}
function revision(database: CaelushDatabase, changed: boolean): number {
  if (
    changed &&
    database.client
      .prepare(
        "UPDATE archive_catalog_meta SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991",
      )
      .run().changes !== 1
  )
    throw new StorageError("The archive catalog revision could not be updated.");
  return database.client
    .prepare("SELECT revision FROM archive_catalog_meta WHERE singleton = 1")
    .get()!.revision as number;
}
function candidate(
  database: CaelushDatabase,
  session: AgentSession,
  policy: ArchivePolicy | undefined,
): LegacyArchiveCandidate {
  const statuses = database.client
    .prepare("SELECT id, status, data_json FROM agent_runs WHERE session_id = ? ORDER BY id")
    .all(session.id)
    .map((row) => ({
      id: row.id,
      status: RunStatusSchema.parse(row.status),
      workspace: WorkspaceRefSchema.parse(
        (JSON.parse(row.data_json as string) as { workspace: unknown }).workspace,
      ),
    }));
  const refs = [
    ...new Map(statuses.map((r) => [JSON.stringify(r.workspace), r.workspace])).values(),
  ];
  return {
    session,
    runWorkspaces: refs.slice(0, 2),
    ambiguous: refs.length > 2 || new Set(refs.map((r) => r.id)).size > 1,
    hasNonTerminalRun: statuses.some((r) => !requirePolicy(policy).isTerminalRunStatus(r.status)),
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify({ session, runs: statuses }))
      .digest("hex"),
  };
}
export function legacyArchiveCandidates(
  database: CaelushDatabase,
  policy: ArchivePolicy | undefined,
  cursor?: string,
): { items: LegacyArchiveCandidate[]; nextCursor?: string } {
  if (cursor !== undefined) SessionIdSchema.parse(cursor);
  const catalog = readArchiveCatalog(database);
  const sessions = catalog.sessions
    .filter(
      (s) =>
        s.workspaceId !== undefined &&
        !catalog.workspaceById.has(s.workspaceId) &&
        !catalog.sessionArchives.has(s.id) &&
        (cursor === undefined || s.id > cursor),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = sessions.slice(0, 100).map((s) => candidate(database, s, policy));
  return { items, ...(sessions.length > 100 ? { nextCursor: items.at(-1)!.session.id } : {}) };
}
export function reconcileLegacyArchives(
  database: CaelushDatabase,
  policy: ArchivePolicy | undefined,
  entries: readonly LegacyArchiveEntry[],
): LegacyArchiveReconcileResult {
  const terminal = requirePolicy(policy).isTerminalRunStatus;
  if (entries.length > 100) throw new StorageError("A legacy reconciliation batch is too large.");
  const migratedSessionIds: SessionId[] = [],
    deferredSessionIds: SessionId[] = [];
  for (const entry of entries) {
    const catalog = readArchiveCatalog(database);
    const session = catalog.sessionById.get(entry.sessionId);
    if (
      session?.workspaceId === undefined ||
      catalog.workspaceById.has(session.workspaceId) ||
      catalog.sessionArchives.has(session.id)
    )
      continue;
    const current = candidate(database, session, policy);
    if (current.evidenceDigest !== entry.expectedEvidenceDigest || current.hasNonTerminalRun) {
      deferredSessionIds.push(session.id);
      continue;
    }
    const workspace =
      entry.workspace === undefined ? undefined : WorkspaceRecordSchema.parse(entry.workspace);
    if (workspace !== undefined) {
      // Audit every sibling in this transaction, including those outside the candidate page.
      // The host supplies only a pure identity predicate; evidence is read under this write lock.
      const matches =
        policy?.legacyWorkspaceMatches ??
        ((w: WorkspaceRecord, ref: WorkspaceRef) =>
          w.id === ref.id && w.canonicalPath === ref.path);
      const siblingsProven = catalog.sessions
        .filter(
          (s) =>
            s.workspaceId === session.workspaceId && !isUnassociatedLegacySession(catalog, s.id),
        )
        .every((sibling) => {
          const proof = candidate(database, sibling, policy);
          const refs = [
            ...(sibling.defaultWorkspace === undefined ? [] : [sibling.defaultWorkspace]),
            ...proof.runWorkspaces,
          ];
          return (
            !proof.ambiguous &&
            !proof.hasNonTerminalRun &&
            refs.length > 0 &&
            refs.every((ref) => matches(workspace, ref))
          );
        });
      if (!siblingsProven) {
        deferredSessionIds.push(session.id);
        continue;
      }
      const siblingActive = database.client
        .prepare(
          "SELECT r.status FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id WHERE s.workspace_id = ?",
        )
        .all(session.workspaceId)
        .some((r) => !terminal(RunStatusSchema.parse(r.status)));
      if (siblingActive) {
        deferredSessionIds.push(session.id);
        continue;
      }
      if (
        workspace.id !== session.workspaceId ||
        current.ambiguous ||
        database.client
          .prepare("SELECT 1 FROM workspaces WHERE canonical_path = ? AND id <> ?")
          .get(workspace.canonicalPath, workspace.id)
      ) {
        deferredSessionIds.push(session.id);
        continue;
      }
      database.client
        .prepare(
          "INSERT INTO workspaces (id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          workspace.id,
          workspace.canonicalPath,
          workspace.displayName,
          workspace.createdAt,
          workspace.updatedAt,
          workspace.lastOpenedAt,
        );
      database.client
        .prepare(
          "INSERT INTO workspace_archives (workspace_id,archive_id,archived_at_ms,reason) VALUES (?, ?, NULL, 'LEGACY_FORGOTTEN_WORKSPACE')",
        )
        .run(workspace.id, randomUUID());
    } else {
      database.client
        .prepare(
          "INSERT INTO session_archives (session_id,archive_id,archived_at_ms,reason) VALUES (?, ?, NULL, 'LEGACY_FORGOTTEN_WORKSPACE')",
        )
        .run(session.id, randomUUID());
    }
    migratedSessionIds.push(session.id);
  }
  return {
    migratedSessionIds,
    deferredSessionIds,
    catalogRevision: revision(database, migratedSessionIds.length > 0),
  };
}
export function importLegacyArchiveMarkers(
  database: CaelushDatabase,
  policy: ArchivePolicy | undefined,
  input: LegacyArchiveImportRequest,
): LegacyArchiveImportResponse {
  const terminal = requirePolicy(policy).isTerminalRunStatus;
  const request = LegacyArchiveImportRequestSchema.parse(input);
  const result: LegacyArchiveImportResponse = {
    importedSessionIds: [],
    alreadyArchivedSessionIds: [],
    rejected: [],
    catalogRevision: 0,
  };
  for (const marker of new Map(request.markers.map((m) => [m.sessionId, m])).values()) {
    const catalog = readArchiveCatalog(database);
    if (!catalog.sessionById.has(marker.sessionId)) {
      result.rejected.push({ sessionId: marker.sessionId, reason: "NOT_OWNED" });
      continue;
    }
    if (
      archiveState(catalog, { type: "SESSION", sessionId: marker.sessionId }).ownArchive !==
      undefined
    ) {
      result.alreadyArchivedSessionIds.push(marker.sessionId);
      continue;
    }
    if (
      database.client
        .prepare("SELECT status FROM agent_runs WHERE session_id = ?")
        .all(marker.sessionId)
        .some((r) => !terminal(RunStatusSchema.parse(r.status)))
    ) {
      result.rejected.push({ sessionId: marker.sessionId, reason: "ACTIVE_RUN_CONFLICT" });
      continue;
    }
    database.client
      .prepare(
        "INSERT INTO session_archives (session_id,archive_id,archived_at_ms,reason) VALUES (?, ?, ?, 'LEGACY_SESSION_MARKER')",
      )
      .run(marker.sessionId, randomUUID(), marker.archivedAt);
    result.importedSessionIds.push(marker.sessionId);
  }
  result.catalogRevision = revision(database, result.importedSessionIds.length > 0);
  return result;
}
