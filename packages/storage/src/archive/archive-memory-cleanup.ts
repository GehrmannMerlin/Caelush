import type { CaelushDatabase } from "../database.js";
import { StorageArchiveConflictError } from "../errors.js";
import type { ArchiveSelectionSet } from "./archive-selection.js";

function ownershipConflict(): never {
  throw new StorageArchiveConflictError(
    "DATA_OWNERSHIP_CONFLICT",
    "Memory evidence ownership could not be proven.",
  );
}
function strings(value: unknown): string[] {
  if (typeof value !== "string") return ownershipConflict();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return ownershipConflict();
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((v): v is string => typeof v === "string" && v.length > 0)
  )
    return ownershipConflict();
  return parsed;
}
function evidenceOwner(database: CaelushDatabase, reference: string): string | undefined {
  const prefix = /^(run|step|message|observation):(.+)$/u.exec(reference);
  const kind = prefix?.[1];
  const id = prefix?.[2] ?? reference;
  const lookups = [
    ["run", "SELECT id AS run_id FROM agent_runs WHERE id = ?"],
    ["step", "SELECT run_id FROM agent_steps WHERE id = ?"],
    ["message", "SELECT run_id FROM agent_messages WHERE message_id = ?"],
    ["observation", "SELECT run_id FROM agent_observations WHERE id = ?"],
  ] as const;
  const owners = new Set(
    lookups
      .filter(([name]) => kind === undefined || kind === name)
      .flatMap(([, sql]) => {
        const row = database.client.prepare(sql).get(id);
        return typeof row?.run_id === "string" ? [row.run_id] : [];
      }),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

/** Synchronous and inside the same graph-deletion transaction; never infers new facts. */
export function cleanupArchiveMemoriesInTransaction(
  database: CaelushDatabase,
  selection: ArchiveSelectionSet,
): void {
  const runs = new Set<string>(selection.runIds);
  const workspaces = new Set<string>(selection.workspaceIds);
  const deleted = new Set<string>();
  const rows = database.client
    .prepare(
      "SELECT id, scope, project_id, source_run_ids_json, evidence_refs_json FROM memory_records",
    )
    .all();
  for (const row of rows) {
    const id = row.id as string;
    if (
      row.scope === "PROJECT" &&
      typeof row.project_id === "string" &&
      workspaces.has(row.project_id)
    ) {
      deleted.add(id);
      continue;
    }
    const sources = strings(row.source_run_ids_json);
    const evidence = strings(row.evidence_refs_json);
    const owners = evidence.map((ref) => evidenceOwner(database, ref));
    if (
      !sources.some((source) => runs.has(source)) &&
      !owners.some((owner) => owner !== undefined && runs.has(owner))
    )
      continue;
    if (sources.length > 0 && sources.every((source) => runs.has(source))) {
      if (owners.some((owner) => owner === undefined || !runs.has(owner))) ownershipConflict();
      deleted.add(id);
      continue;
    }
    // Current memory records have no per-fact support proof. An existing remaining Run ID
    // cannot establish that the full fact is independent of the source being deleted.
    ownershipConflict();
  }
  const remove = database.client.prepare("DELETE FROM memory_records WHERE id = ?");
  const clear = database.client.prepare(
    "UPDATE memory_records SET supersedes = CASE WHEN supersedes = ? THEN NULL ELSE supersedes END, superseded_by = CASE WHEN superseded_by = ? THEN NULL ELSE superseded_by END WHERE supersedes = ? OR superseded_by = ?",
  );
  for (const id of deleted) clear.run(id, id, id, id);
  for (const id of deleted) remove.run(id);
}
