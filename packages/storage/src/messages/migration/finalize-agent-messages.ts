import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrateSync } from "drizzle-orm/sqlite-core/async/session";
import { StorageMigrationError } from "../../errors.js";
import type { CaelushDatabase } from "../../database.js";
import { backfillLegacyAgentMessages } from "../legacy/backfill.js";
import { parseHistoricalLegacyMessage } from "./legacy-parser.js";

const FINAL_MIGRATION_NAME = "20260924120000_message_system_v2_final";

/** Apply all published migrations before the final physical Message V2 rebuild. */
export function migratePublishedStorage(database: CaelushDatabase, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  const final = migrations.find((migration) => migration.name === FINAL_MIGRATION_NAME);
  if (final === undefined) {
    throw new StorageMigrationError("Final Message V2 migration asset is missing");
  }
  migrateSync(
    migrations.filter((migration) => migration.name !== FINAL_MIGRATION_NAME),
    database.drizzle._.session,
  );
}

/**
 * Complete Stage C exactly once, after the transitional Drizzle migrations have run.
 *
 * The backfill is intentionally outside the physical rebuild transaction because it is resumable one
 * row at a time. The destructive copy is a separate transaction that cannot start unless the gate has
 * proved that no legacy-only row remains.
 */
export function finalizeAgentMessages(database: CaelushDatabase, migrationsFolder: string): void {
  if (isFinalSchema(database)) return;

  const migration = readMigrationFiles({ migrationsFolder }).find(
    (entry) => entry.name === FINAL_MIGRATION_NAME,
  );
  if (migration === undefined) {
    throw new StorageMigrationError("Final Message V2 migration asset is missing");
  }

  const report = backfillLegacyAgentMessages(database, {
    parse: parseHistoricalLegacyMessage,
  });
  const remainingLegacy = countLegacyRows(database);
  if (report.failed > 0 || report.unsupported > 0 || remainingLegacy !== 0) {
    throw new StorageMigrationError("Message V2 Stage C backfill did not close all legacy rows");
  }

  const client = database.client;
  client.exec("PRAGMA foreign_keys = OFF");
  client.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of migration.sql) {
      client.exec(statement);
    }
    client
      .prepare(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at")
         VALUES (?, ?, ?, ?)`,
      )
      .run(migration.hash, migration.folderMillis, migration.name, new Date().toISOString());
    client.exec("COMMIT");
  } catch (error) {
    try {
      client.exec("ROLLBACK");
    } finally {
      client.exec("PRAGMA foreign_keys = ON");
    }
    throw new StorageMigrationError("Message V2 Stage C physical rebuild failed", { cause: error });
  }
  client.exec("PRAGMA foreign_keys = ON");
  const integrity = client.prepare("PRAGMA foreign_key_check").all();
  if (integrity.length > 0 || !isFinalSchema(database)) {
    throw new StorageMigrationError("Message V2 Stage C final schema verification failed");
  }
}

function countLegacyRows(database: CaelushDatabase): number {
  const row = database.client
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE v2_data_json IS NULL")
    .get() as { count: number };
  return row.count;
}

function isFinalSchema(database: CaelushDatabase): boolean {
  const columns = database.client.prepare("PRAGMA table_info('agent_messages')").all() as Array<{
    name: string;
    pk: number;
    notnull: number;
  }>;
  const names = columns.map((column) => column.name);
  const expected = [
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
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) return false;
  const messageId = columns.find((column) => column.name === "message_id");
  if (messageId?.pk !== 1 || messageId.notnull !== 1) return false;
  return [
    "agent_messages_run_sequence_idx",
    "agent_messages_session_created_idx",
    "agent_messages_turn_sequence_idx",
    "agent_messages_type_idx",
  ].every((name) =>
    Boolean(
      database.client
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name),
    ),
  );
}

export { FINAL_MIGRATION_NAME };
