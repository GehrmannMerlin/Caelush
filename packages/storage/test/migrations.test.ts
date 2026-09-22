import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { StorageMigrationError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("committed storage migrations", () => {
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
      // Phase 5B added the thirteenth committed migration: the Message V2 storage substrate. It is
      // additive, so the table set above is unchanged and only the count moves.
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get()).toEqual({
        count: 13,
      });

      // And the substrate is really there, on a database built from nothing.
      const columns = sqlite.prepare("PRAGMA table_info('agent_messages')").all() as Array<{
        name: string;
      }>;
      const names = columns.map(({ name }) => name);
      for (const added of [
        "message_id",
        "session_id",
        "conversation_turn_id",
        "message_type",
        "schema_version",
        "model_projection_version",
        "source_json",
        "audience_json",
        "v2_data_json",
      ]) {
        expect(names, added).toContain(added);
      }
      // The legacy surface is preserved: the current production writer depends on all of it.
      for (const legacy of [
        "run_id",
        "sequence",
        "role",
        "protocol_version",
        "data_json",
        "created_at_ms",
      ]) {
        expect(names, legacy).toContain(legacy);
      }

      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map(({ name }) => name);
      for (const index of [
        "agent_messages_message_id_unique",
        "agent_messages_session_sequence_idx",
        "agent_messages_conversation_turn_idx",
        "agent_messages_message_type_idx",
      ]) {
        expect(indexNames, index).toContain(index);
      }

      // No turn table: a turn is derived from Run metadata plus message records.
      expect(tables.map(({ name }) => name)).not.toContain("conversation_turns");
    } finally {
      sqlite.close();
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
