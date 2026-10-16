import type { PermanentDeletionResponse, RunId, SessionId, WorkspaceId } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageError } from "../errors.js";
import { cleanupArchiveMemoriesInTransaction } from "./archive-memory-cleanup.js";
import type { ArchiveSelectionSet } from "./archive-selection.js";

export interface ArchiveDeletionCommit {
  readonly response: PermanentDeletionResponse;
  readonly deletedSessionIds: readonly SessionId[];
  readonly deletedRunIds: readonly RunId[];
  readonly deletedWorkspaceIds: readonly WorkspaceId[];
}

export function purgeArchiveGraphInTransaction(
  database: CaelushDatabase,
  selection: ArchiveSelectionSet,
): ArchiveDeletionCommit {
  if (!database.client.isTransaction)
    throw new StorageError("Archive deletion requires a transaction.");
  for (const table of [
    "archive_delete_runs",
    "archive_delete_sessions",
    "archive_delete_workspaces",
  ])
    database.client.exec(
      `CREATE TEMP TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY); DELETE FROM ${table}`,
    );
  for (const [table, ids] of [
    ["archive_delete_runs", selection.runIds],
    ["archive_delete_sessions", selection.sessionIds],
    ["archive_delete_workspaces", selection.workspaceIds],
  ] as const) {
    const insert = database.client.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
    for (const id of ids) insert.run(id);
  }
  cleanupArchiveMemoriesInTransaction(database, selection);
  // Explicit child-first deletion. FKs stay enabled and any unknown external reference aborts all work.
  const runTables = [
    "private_replays",
    "agent_messages",
    "agent_events",
    "event_sequences",
    "agent_run_continuations",
    "agent_state_snapshots",
    "approval_requests",
    "agent_observations",
    "tool_invocations",
    "run_cancellation_requests",
    "run_budget_entries",
    "provider_invocation_usage",
    "run_resource_states",
    "context_checkpoints",
    "context_artifacts",
    "context_runtime_states",
    "prompt_surface_records",
    "prompt_surface_section_state",
    "prompt_surface_snapshots",
    "prompt_surface_epochs",
  ];
  for (const table of runTables)
    database.client.exec(
      `DELETE FROM ${table} WHERE run_id IN (SELECT id FROM archive_delete_runs)`,
    );
  database.client.exec(
    "DELETE FROM verification_evidence WHERE plan_id IN (SELECT id FROM verification_plans WHERE run_id IN (SELECT id FROM archive_delete_runs))",
  );
  database.client.exec(
    "DELETE FROM verification_checks WHERE plan_id IN (SELECT id FROM verification_plans WHERE run_id IN (SELECT id FROM archive_delete_runs))",
  );
  database.client.exec(
    "DELETE FROM verification_plans WHERE run_id IN (SELECT id FROM archive_delete_runs)",
  );
  database.client.exec(
    "DELETE FROM memory_extraction_jobs WHERE source_run_id IN (SELECT id FROM archive_delete_runs)",
  );
  for (const table of ["agent_steps", "agent_runs"])
    database.client.exec(
      `DELETE FROM ${table} WHERE ${table === "agent_runs" ? "id" : "run_id"} IN (SELECT id FROM archive_delete_runs)`,
    );
  database.client.exec(
    "DELETE FROM session_archives WHERE session_id IN (SELECT id FROM archive_delete_sessions)",
  );
  database.client.exec(
    "DELETE FROM agent_sessions WHERE id IN (SELECT id FROM archive_delete_sessions)",
  );
  database.client.exec(
    "DELETE FROM workspace_archives WHERE workspace_id IN (SELECT id FROM archive_delete_workspaces)",
  );
  database.client.exec(
    "DELETE FROM workspaces WHERE id IN (SELECT id FROM archive_delete_workspaces)",
  );
  if (
    database.client
      .prepare(
        "UPDATE archive_catalog_meta SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991",
      )
      .run().changes !== 1
  )
    throw new StorageError("The archive catalog revision could not be updated.");
  const catalogRevision = database.client
    .prepare("SELECT revision FROM archive_catalog_meta WHERE singleton = 1")
    .get()!.revision as number;
  for (const table of [
    "archive_delete_runs",
    "archive_delete_sessions",
    "archive_delete_workspaces",
  ])
    database.client.exec(`DELETE FROM ${table}`);
  return {
    response: { counts: selection.snapshot.counts, catalogRevision },
    deletedSessionIds: selection.sessionIds,
    deletedRunIds: selection.runIds,
    deletedWorkspaceIds: selection.workspaceIds,
  };
}
