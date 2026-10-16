import { createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import type { CaelushDatabase } from "../../src/database.js";
import { SqliteSessionRepository } from "../../src/repositories/session-repository.js";
import { SqliteRunRepository } from "../../src/repositories/run-repository.js";
import { SqliteWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { makeRun, makeSession } from "../support/fixtures.js";

export const graphTables = [
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
  "verification_evidence",
  "verification_checks",
  "verification_plans",
  "memory_extraction_jobs",
  "agent_steps",
] as const;
// Child rows exercise physical ownership/FKs. Root entities use production codecs.
function row(
  database: CaelushDatabase,
  table: string,
  values: Record<string, string | number | null>,
) {
  const columns = database.client.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
    dflt_value: string | null;
  }[];
  const entries = columns
    .filter((c) => c.name in values || ((c.notnull || c.pk) && c.dflt_value === null))
    .map(
      (c) =>
        [
          c.name,
          values[c.name] ??
            (c.type === "INTEGER" ? 1 : c.name.endsWith("_json") ? "{}" : `${table}:${c.name}`),
        ] as const,
    );
  database.client
    .prepare(
      `INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
    )
    .run(...entries.map(([, value]) => value));
}
export async function archiveGraph(database: CaelushDatabase, label: string) {
  const stamp = createTimestampMs(1);
  const workspace = {
    id: createWorkspaceId(),
    canonicalPath: `D:/项目/${label}`,
    displayName: label,
    createdAt: stamp,
    updatedAt: stamp,
    lastOpenedAt: stamp,
  };
  await new SqliteWorkspaceRepository(database).insert(workspace);
  const session = makeSession({
    workspaceId: workspace.id,
    title: label,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
  });
  await new SqliteSessionRepository(database).insert(session);
  const run = makeRun(session.id, { status: "COMPLETED", workspace: session.defaultWorkspace! });
  await new SqliteRunRepository(database).insert(run);
  const stepId = `${label}:step`,
    messageId = `${label}:message`,
    invocationId = `${label}:tool`,
    planId = `${label}:plan`,
    checkId = `${label}:check`;
  const common = {
    run_id: run.id,
    session_id: session.id,
    step_id: stepId,
    source_step_id: stepId,
    data_json: "{}",
  };
  row(database, "agent_steps", { ...common, id: stepId });
  row(database, "agent_messages", {
    ...common,
    message_id: messageId,
    message_type: "USER",
    source_json: "{}",
    audience_json: "[]",
  });
  row(database, "private_replays", {
    ...common,
    message_id: messageId,
    key_id: label,
    nonce: label,
  });
  row(database, "tool_invocations", { ...common, id: invocationId });
  row(database, "agent_observations", {
    ...common,
    id: `${label}:observation`,
    tool_invocation_id: invocationId,
  });
  row(database, "approval_requests", {
    ...common,
    id: `${label}:approval`,
    tool_invocation_id: invocationId,
  });
  row(database, "verification_plans", { ...common, id: planId });
  row(database, "verification_checks", { id: checkId, plan_id: planId });
  row(database, "verification_evidence", {
    id: `${label}:evidence`,
    plan_id: planId,
    check_id: checkId,
  });
  row(database, "prompt_surface_epochs", { ...common, epoch_id: label });
  row(database, "prompt_surface_snapshots", {
    ...common,
    epoch_id: label,
    kind: "RUNTIME_CONTEXT_SNAPSHOT",
  });
  row(database, "prompt_surface_records", {
    ...common,
    epoch_id: label,
    kind: "BASELINE",
    anchor_message_id: messageId,
    anchor_run_id: run.id,
  });
  row(database, "prompt_surface_section_state", { ...common, epoch_id: label });
  row(database, "memory_extraction_jobs", {
    id: `${label}:job`,
    source_run_id: run.id,
    project_id: workspace.id,
    status: "RUNNING",
    attempt: 1,
  });
  for (const table of [
    "agent_events",
    "event_sequences",
    "agent_run_continuations",
    "agent_state_snapshots",
    "run_cancellation_requests",
    "run_budget_entries",
    "provider_invocation_usage",
    "run_resource_states",
    "context_checkpoints",
    "context_artifacts",
    "context_runtime_states",
  ]) {
    row(database, table, {
      ...common,
      id: `${label}:${table}`,
      event_id: `${label}:event`,
      call_id: `${label}:call`,
    });
  }
  return { workspace, session, run };
}
