import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveLegacyAgentMessageId } from "@caelush/agent";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { StorageMigrationError } from "../src/errors.js";
import { openCaelushDatabase } from "../src/database.js";
import { getCaelushMigrationsFolder } from "../src/migrate.js";
import {
  finalizeAgentMessages,
  migratePublishedStorage,
} from "../src/messages/migration/finalize-agent-messages.js";
import { backfillLegacyAgentMessages } from "../src/messages/legacy/backfill.js";
import { parseHistoricalLegacyMessage } from "../src/messages/migration/legacy-parser.js";

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
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-storage-final-message-schema-"));
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
      expect(columns.find(({ name }) => name === "message_id")).toMatchObject({ pk: 1, notnull: 1 });
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
        "approval_requests",
        "context_artifacts",
        "context_checkpoints",
        "context_runtime_states",
        "event_sequences",
        "memory_extraction_jobs",
        "memory_records",
        "run_budget_entries",
        "run_cancellation_requests",
        "run_resource_states",
        "tool_invocations",
        "verification_checks",
        "verification_evidence",
        "verification_plans",
      ]);
      // Phase 5F adds the final Message V2 physical schema after the thirteen historical migrations.
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get()).toEqual({
        count: 14,
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
        database.client.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE v2_data_json IS NULL").get(),
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
      expect(
        database.client.prepare("SELECT COUNT(*) AS count FROM agent_messages").get(),
      ).toEqual({ count: 3 });
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

      expect(() => finalizeAgentMessages(database, migrationsFolder)).toThrow(StorageMigrationError);
      expect(database.client.prepare("PRAGMA table_info('agent_messages')").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "v2_data_json" })]),
      );
      expect(
        database.client
          .prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations" WHERE name = ?')
          .get("20260924120000_message_system_v2_final"),
      ).toEqual({ count: 0 });

      database.client
        .prepare("UPDATE agent_messages SET role = ?, data_json = ? WHERE run_id = ? AND sequence = ?")
        .run("user", JSON.stringify({ role: "user", content: "repaired" }), "run_repair", 2);
      finalizeAgentMessages(database, migrationsFolder);
      expect(database.client.prepare("PRAGMA table_info('agent_messages')").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "v2_data_json" })]),
      );
      expect(database.client.prepare("SELECT data_json FROM agent_messages WHERE sequence = 2").get()).toMatchObject({
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
