import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveLegacyAgentMessageId, hashPromptSurfaceContent } from "@caelush/agent";
import { AgentRunSchema, createRunId, createSessionId, createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { StorageMigrationError } from "../src/errors.js";
import { openCaelushDatabase } from "../src/database.js";
import { getCaelushMigrationsFolder } from "../src/migrate.js";
import { finalizeRunSecurityPolicies } from "../src/security-policy-migration.js";
import {
  finalizeAgentMessages,
  migratePublishedStorage,
} from "../src/messages/migration/finalize-agent-messages.js";
import { backfillLegacyAgentMessages } from "../src/messages/legacy/backfill.js";
import { parseHistoricalLegacyMessage } from "../src/messages/migration/legacy-parser.js";
import { makeRun, makeSecurityPolicy } from "./support/fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("committed storage migrations", () => {
  it("builds the final Message V2 agent_messages schema on a fresh database", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-storage-final-message-schema-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");

    const storage = await openCaelushStorage({ path: databasePath });
    await storage.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      const columns = sqlite.prepare("PRAGMA table_info('agent_messages')").all() as Array<{
        name: string;
        pk: number;
        notnull: number;
      }>;
      expect(columns.map(({ name }) => name)).toEqual([
        "message_id",
        "run_id",
        "session_id",
        "sequence",
        "conversation_turn_id",
        "message_type",
        "schema_version",
        "model_projection_version",
        "source_step_id",
        "created_at_ms",
        "source_json",
        "audience_json",
        "data_json",
      ]);
      expect(columns.find(({ name }) => name === "message_id")).toMatchObject({
        pk: 1,
        notnull: 1,
      });
      expect(columns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(["role", "protocol_version", "v2_data_json"]),
      );

      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "agent_messages_run_sequence_idx",
          "agent_messages_session_created_idx",
          "agent_messages_turn_sequence_idx",
          "agent_messages_type_idx",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("adds context checkpoints, artifacts, and memory without dropping existing tables", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-context-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const first = await openCaelushStorage({ path: databasePath });
    await first.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["context_checkpoints", "context_artifacts", "memory_records"]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("creates every table on a fresh file and safely reruns the migration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");

    const first = await openCaelushStorage({ path: databasePath });
    await first.close();

    const second = await openCaelushStorage({ path: databasePath });
    await second.close();

    const sqlite = new DatabaseSync(databasePath);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    try {
      expect(tables.map(({ name }) => name)).toEqual([
        "__drizzle_migrations",
        "agent_events",
        "agent_messages",
        "agent_observations",
        "agent_run_continuations",
        "agent_runs",
        "agent_sessions",
        "agent_state_snapshots",
        "agent_steps",
        "ai_default_selections",
        "ai_provider_credentials",
        "approval_requests",
        "context_artifacts",
        "context_checkpoints",
        "context_runtime_states",
        "event_sequences",
        "memory_extraction_jobs",
        "memory_records",
        "private_replays",
        "prompt_surface_epochs",
        "prompt_surface_records",
        "prompt_surface_section_state",
        "prompt_surface_snapshots",
        "provider_invocation_usage",
        "run_budget_entries",
        "run_cancellation_requests",
        "run_resource_states",
        "tool_invocations",
        "verification_checks",
        "verification_evidence",
        "verification_plans",
        "workspaces",
      ]);
      // Phase 5F, the Workspace Registry, Runtime AI Management, scoped Prompt Surface anchors,
      // and Prompt Surface V3 state are represented in the published migration ledger.
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get()).toEqual({
        count: 24,
      });

      // The final schema contains only the durable Message V2 envelope and payload.
      const columns = sqlite.prepare("PRAGMA table_info('agent_messages')").all() as Array<{
        name: string;
      }>;
      const names = columns.map(({ name }) => name);
      expect(names).toEqual([
        "message_id",
        "run_id",
        "session_id",
        "sequence",
        "conversation_turn_id",
        "message_type",
        "schema_version",
        "model_projection_version",
        "source_step_id",
        "created_at_ms",
        "source_json",
        "audience_json",
        "data_json",
      ]);
      expect(names).not.toEqual(
        expect.arrayContaining(["role", "protocol_version", "v2_data_json"]),
      );

      const promptSurfaceColumns = sqlite
        .prepare("PRAGMA table_info('prompt_surface_snapshots')")
        .all() as Array<{ name: string }>;
      expect(promptSurfaceColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "anchor_message_id",
          "anchor_run_id",
          "anchor_conversation_turn_id",
        ]),
      );

      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map(({ name }) => name);
      for (const index of [
        "agent_messages_run_sequence_idx",
        "agent_messages_session_created_idx",
        "agent_messages_turn_sequence_idx",
        "agent_messages_type_idx",
      ]) {
        expect(indexNames, index).toContain(index);
      }

      // No turn table: a turn is derived from Run metadata plus message records.
      expect(tables.map(({ name }) => name)).not.toContain("conversation_turns");
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a database at the previous migration boundary without dropping existing tables", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-storage-prompt-surface-upgrade-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const priorMigrationsFolder = path.join(directory, "prior-drizzle");
    await mkdir(priorMigrationsFolder);
    const publishedFolders = await readdir(getCaelushMigrationsFolder(), {
      withFileTypes: true,
    });
    for (const entry of publishedFolders) {
      if (
        !entry.isDirectory() ||
        entry.name === "20261006100000_prompt_surface" ||
        entry.name === "20261006110000_prompt_surface_same_step_epochs" ||
        entry.name === "20261007120000_prompt_surface_scoped_anchors" ||
        entry.name === "20261008100000_prompt_surface_v3" ||
        entry.name === "20261008120000_private_replay" ||
        entry.name === "20261008140000_cache_usage_accounting" ||
        entry.name === "20261008160000_provider_invocation_usage"
      )
        continue;
      await cp(
        path.join(getCaelushMigrationsFolder(), entry.name),
        path.join(priorMigrationsFolder, entry.name),
        { recursive: true },
      );
    }

    const priorDatabase = await openCaelushDatabase({ path: databasePath });
    try {
      migratePublishedStorage(priorDatabase, priorMigrationsFolder);
      finalizeAgentMessages(priorDatabase, priorMigrationsFolder);
      finalizeRunSecurityPolicies(priorDatabase);
      const cacheMigrationSessionId = createSessionId();
      const cacheMigrationRun = AgentRunSchema.parse(
        makeRun(cacheMigrationSessionId, { status: "COMPLETED" }),
      );
      priorDatabase.client
        .prepare(
          "INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json) VALUES (?, 1, 1, 1, '{}')",
        )
        .run(cacheMigrationSessionId);
      priorDatabase.client
        .prepare(
          "INSERT INTO agent_runs (id, session_id, protocol_version, status, created_at_ms, data_json) VALUES (?, ?, 1, 'COMPLETED', 1, ?)",
        )
        .run(cacheMigrationRun.id, cacheMigrationSessionId, JSON.stringify(cacheMigrationRun));
      priorDatabase.client
        .prepare(
          `INSERT INTO run_budget_entries
           (id, run_id, kind, owner_id, state, reserved_tool_calls, reserved_input_tokens,
            reserved_output_tokens, actual_input_tokens, actual_output_tokens, reserved_cost_micros,
            actual_cost_micros, model_provider, model_id, pricing_snapshot_id,
            input_rate_micros_per_million, output_rate_micros_per_million, created_at_ms,
            started_at_ms, settled_at_ms)
           VALUES ('legacy-cache-usage', ?, 'VERIFICATION_LLM', 'verify-old',
                   'SETTLED', 0, 18000, 2000, 16017, 1311, 0, 123, 'fixture', 'model', NULL,
                   NULL, NULL, 1, 1, 2)`,
        )
        .run(cacheMigrationRun.id);
      expect(
        priorDatabase.client.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get(),
      ).toEqual({ count: 17 });
    } finally {
      priorDatabase.close();
    }

    const upgraded = await openCaelushStorage({ path: databasePath });
    await upgraded.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      const names = (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(names).toEqual(
        expect.arrayContaining([
          "agent_messages",
          "agent_runs",
          "prompt_surface_epochs",
          "prompt_surface_records",
          "prompt_surface_section_state",
          "prompt_surface_snapshots",
        ]),
      );
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get()).toEqual({
        count: 24,
      });
      expect(
        sqlite
          .prepare(
            "SELECT actual_input_tokens, actual_output_tokens, actual_cost_micros, cache_hit_input_tokens, cache_miss_input_tokens, cache_write_input_tokens FROM run_budget_entries WHERE id = 'legacy-cache-usage'",
          )
          .get(),
      ).toEqual({
        actual_input_tokens: 16_017,
        actual_output_tokens: 1_311,
        actual_cost_micros: 123,
        cache_hit_input_tokens: null,
        cache_miss_input_tokens: null,
        cache_write_input_tokens: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("adds V3 storage without rewriting existing V2 Prompt Surface records", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-prompt-surface-v2-data-upgrade-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const priorMigrationsFolder = path.join(directory, "prior-drizzle");
    await mkdir(priorMigrationsFolder);
    const publishedFolders = await readdir(getCaelushMigrationsFolder(), { withFileTypes: true });
    for (const entry of publishedFolders) {
      if (!entry.isDirectory() || entry.name === "20261008100000_prompt_surface_v3") continue;
      await cp(
        path.join(getCaelushMigrationsFolder(), entry.name),
        path.join(priorMigrationsFolder, entry.name),
        {
          recursive: true,
        },
      );
    }

    const priorDatabase = await openCaelushDatabase({ path: databasePath });
    const runId = createRunId();
    const sessionId = createSessionId();
    const content =
      '<runtime_context_snapshot state="CURRENT">immutable V2</runtime_context_snapshot>';
    const contentHash = hashPromptSurfaceContent(content);
    try {
      migratePublishedStorage(priorDatabase, priorMigrationsFolder);
      seedHistoricalRun(priorDatabase, runId, sessionId);
      const historicalRun = AgentRunSchema.parse({
        id: runId,
        sessionId,
        goal: "preserve V2 surface data",
        status: "COMPLETED",
        workspace: { id: createWorkspaceId(), path: directory },
        model: { provider: "deepseek", model: "deepseek-chat" },
        runtime: { id: "local", kind: "local" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ON_BOUNDARY",
        securityPolicy: makeSecurityPolicy(),
        limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
        createdAt: 1,
      });
      priorDatabase.client
        .prepare("UPDATE agent_runs SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(historicalRun), historicalRun.id);
      finalizeRunSecurityPolicies(priorDatabase);
      priorDatabase.client
        .prepare(
          `INSERT INTO prompt_surface_epochs
         (run_id, epoch_id, model_provider, model_id, stable_head_fingerprint,
          tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
          created_step_sequence, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          "epoch_prompt_surface_v2",
          "deepseek",
          "deepseek-chat",
          `sha256:${"1".repeat(64)}`,
          `sha256:${"2".repeat(64)}`,
          `sha256:${"3".repeat(64)}`,
          "INITIAL",
          1,
          2,
        );
      priorDatabase.client
        .prepare(
          `INSERT INTO prompt_surface_snapshots
         (run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id, anchor_run_id,
          anchor_conversation_turn_id, source_step_sequence, kind, content_hash, byte_length,
          created_at_ms, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          "epoch_prompt_surface_v2",
          1,
          1,
          "amsg_prompt_surface_v2",
          runId,
          "cturn_prompt_surface_v2",
          1,
          "RUNTIME_CONTEXT_SNAPSHOT",
          contentHash,
          Buffer.byteLength(content, "utf8"),
          3,
          content,
        );
    } finally {
      priorDatabase.close();
    }

    const upgraded = await openCaelushStorage({ path: databasePath });
    try {
      await expect(upgraded.promptSurface.getCurrent(runId)).resolves.toMatchObject({
        formatVersion: 2,
        epochId: "epoch_prompt_surface_v2",
      });
      await expect(
        upgraded.promptSurface.readEpoch(runId, "epoch_prompt_surface_v2" as never),
      ).resolves.toMatchObject({
        formatVersion: 2,
        snapshots: [{ content, contentHash }],
      });
    } finally {
      await upgraded.close();
    }
  });

  it("upgrades historical transitional rows through the Stage C gate without changing payload semantics", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-stage-c-upgrade-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const database = await openCaelushDatabase({ path: databasePath });
    try {
      const migrationsFolder = getCaelushMigrationsFolder();
      migratePublishedStorage(database, migrationsFolder);
      seedHistoricalRun(database, "run_stage_c", "session_stage_c");
      seedLegacyMessage(database, {
        runId: "run_stage_c",
        sequence: 1,
        role: "user",
        data: { role: "user", content: "inspect the parser" },
      });
      seedLegacyMessage(database, {
        runId: "run_stage_c",
        sequence: 2,
        role: "assistant",
        data: { role: "assistant", content: [{ type: "text", text: "I found it." }] },
      });
      seedLegacyMessage(database, {
        runId: "run_stage_c",
        sequence: 3,
        role: "tool",
        data: {
          role: "tool",
          toolCallId: "call_parser",
          toolName: "read_file",
          content: "parser source",
          isError: false,
        },
      });

      expect(
        database.client
          .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE v2_data_json IS NULL")
          .get(),
      ).toEqual({ count: 3 });

      finalizeAgentMessages(database, migrationsFolder);

      const rows = database.client
        .prepare("SELECT message_id, message_type, data_json FROM agent_messages ORDER BY sequence")
        .all() as Array<{ message_id: string; message_type: string; data_json: string }>;
      expect(rows.map((row) => row.message_type)).toEqual(["USER", "ASSISTANT", "TOOL_RESULT"]);
      expect(rows[0]?.message_id).toBe(deriveLegacyAgentMessageId("run_stage_c" as never, 1));
      expect(JSON.parse(rows[2]!.data_json)).toMatchObject({
        toolCallId: "call_parser",
        projectedContent: "parser source",
      });
      expect(database.client.prepare("PRAGMA table_info('agent_messages')").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "v2_data_json" })]),
      );
      expect(database.client.prepare("SELECT COUNT(*) AS count FROM agent_messages").get()).toEqual(
        { count: 3 },
      );
    } finally {
      database.close();
    }
  });

  it("fails closed on an unsupported historical row and can resume after the data is repaired", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-stage-c-repair-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const database = await openCaelushDatabase({ path: databasePath });
    try {
      const migrationsFolder = getCaelushMigrationsFolder();
      migratePublishedStorage(database, migrationsFolder);
      seedHistoricalRun(database, "run_repair", "session_repair");
      seedLegacyMessage(database, {
        runId: "run_repair",
        sequence: 1,
        role: "user",
        data: { role: "user", content: "already migrated" },
      });
      seedLegacyMessage(database, {
        runId: "run_repair",
        sequence: 2,
        role: "system",
        data: { role: "system", content: "must not be persisted" },
      });

      const partial = backfillLegacyAgentMessages(database, {
        runId: "run_repair" as never,
        parse: parseHistoricalLegacyMessage,
      });
      expect(partial).toMatchObject({ migrated: 1, unsupported: 1, failed: 0 });

      expect(() => finalizeAgentMessages(database, migrationsFolder)).toThrow(
        StorageMigrationError,
      );
      expect(database.client.prepare("PRAGMA table_info('agent_messages')").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "v2_data_json" })]),
      );
      expect(
        database.client
          .prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations" WHERE name = ?')
          .get("20260924120000_message_system_v2_final"),
      ).toEqual({ count: 0 });

      database.client
        .prepare(
          "UPDATE agent_messages SET role = ?, data_json = ? WHERE run_id = ? AND sequence = ?",
        )
        .run("user", JSON.stringify({ role: "user", content: "repaired" }), "run_repair", 2);
      finalizeAgentMessages(database, migrationsFolder);
      expect(database.client.prepare("PRAGMA table_info('agent_messages')").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "v2_data_json" })]),
      );
      expect(
        database.client.prepare("SELECT data_json FROM agent_messages WHERE sequence = 2").get(),
      ).toMatchObject({
        data_json: expect.stringContaining("repaired"),
      });
    } finally {
      database.close();
    }
  });

  it("fails closed when a committed migration cannot be applied", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-migration-failure-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec("CREATE TABLE agent_events (event_id TEXT PRIMARY KEY)");
    sqlite.close();

    await expect(openCaelushStorage({ path: databasePath })).rejects.toBeInstanceOf(
      StorageMigrationError,
    );
  });
});

function seedHistoricalRun(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  runId: string,
  sessionId: string,
): void {
  database.client
    .prepare(
      "INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(sessionId, 1, 1, 1, "{}");
  database.client
    .prepare(
      "INSERT INTO agent_runs (id, session_id, protocol_version, status, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(runId, sessionId, 1, "COMPLETED", 1, "{}");
}

function seedLegacyMessage(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  input: {
    runId: string;
    sequence: number;
    role: string;
    data: unknown;
  },
): void {
  database.client
    .prepare(
      "INSERT INTO agent_messages (run_id, sequence, role, source_step_id, protocol_version, created_at_ms, data_json) VALUES (?, ?, ?, NULL, ?, ?, ?)",
    )
    .run(input.runId, input.sequence, input.role, 1, input.sequence, JSON.stringify(input.data));
}
