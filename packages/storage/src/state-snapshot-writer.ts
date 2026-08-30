import { AgentStateSchema, type AgentState } from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { encodeProtocol } from "./codec.js";

export function writeStateSnapshot(
  client: CaelushDatabase["client"],
  state: AgentState,
  expected: number | null,
  assertRevision: (actual: number | undefined, expected: number | null) => void,
): number {
  const parsed = AgentStateSchema.parse(state);
  const existing = client
    .prepare("SELECT revision FROM agent_state_snapshots WHERE run_id = ?")
    .get(parsed.runId) as { revision: number } | undefined;
  assertRevision(existing?.revision, expected);
  const revision = (existing?.revision ?? 0) + 1;
  const dataJson = encodeProtocol(AgentStateSchema, parsed, {
    entityType: "AgentState",
    entityId: parsed.runId,
    table: "agent_state_snapshots",
  });
  if (existing) {
    client
      .prepare(
        "UPDATE agent_state_snapshots SET revision = ?, updated_at_ms = ?, data_json = ? WHERE run_id = ?",
      )
      .run(revision, parsed.updatedAt, dataJson, parsed.runId);
  } else {
    client
      .prepare(
        "INSERT INTO agent_state_snapshots (run_id, revision, updated_at_ms, data_json) VALUES (?, ?, ?, ?)",
      )
      .run(parsed.runId, revision, parsed.updatedAt, dataJson);
  }
  return revision;
}
