import type { ArchiveTarget } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageArchiveConflictError, StorageNotFoundError } from "../errors.js";
import { archiveTransaction } from "./archive-transaction.js";

/** Reuse the authority transaction when called by an execution adapter. */
export function withArchiveWriteTransaction<T>(database: CaelushDatabase, operation: () => T): T {
  return database.client.isTransaction
    ? operation()
    : archiveTransaction(database, true, operation);
}

/** Availability only: Run lifecycle decisions remain in Core. */
export function assertArchiveWritableInTransaction(
  database: Pick<CaelushDatabase, "client">,
  target: ArchiveTarget,
): void {
  if (target.type === "WORKSPACE") {
    // Historical Sessions may reference a missing registry row. This is not a new registry FK.
    if (
      database.client
        .prepare("SELECT 1 FROM workspace_archives WHERE workspace_id = ?")
        .get(target.workspaceId) !== undefined
    ) {
      throw new StorageArchiveConflictError(
        "WORKSPACE_ARCHIVED",
        "Restore the Workspace before changing it.",
      );
    }
    return;
  }
  const session = database.client
    .prepare("SELECT workspace_id FROM agent_sessions WHERE id = ?")
    .get(target.sessionId);
  if (session === undefined) throw new StorageNotFoundError("AgentSession", target.sessionId);
  if (
    database.client
      .prepare("SELECT 1 FROM session_archives WHERE session_id = ?")
      .get(target.sessionId) !== undefined ||
    (session.workspace_id !== null &&
      database.client
        .prepare("SELECT 1 FROM workspace_archives WHERE workspace_id = ?")
        .get(session.workspace_id!) !== undefined)
  ) {
    throw new StorageArchiveConflictError(
      "OBJECT_ARCHIVED",
      "Restore the Session before changing it.",
    );
  }
}
