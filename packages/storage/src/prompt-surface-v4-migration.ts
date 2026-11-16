import { readMigrationFiles } from "drizzle-orm/migrator";

import type { CaelushDatabase } from "./database.js";
import { StorageMigrationError } from "./errors.js";

const MIGRATION_NAME = "20261116120000_prompt_surface_v4";

/** Rebuild Prompt Surface epoch metadata so existing V2/V3 rows remain byte-for-byte intact. */
export function migratePromptSurfaceV4(database: CaelushDatabase, migrationsFolder: string): void {
  const schema = database.client
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_surface_epochs'",
    )
    .get() as { sql: string } | undefined;
  if (schema?.sql === undefined) {
    throw new StorageMigrationError(
      "Prompt Surface epoch table is missing before its V4 migration",
    );
  }
  if (/format_version[^)]*IN\s*\(\s*2\s*,\s*3\s*,\s*4\s*\)/u.test(schema.sql)) return;

  const migration = readMigrationFiles({ migrationsFolder }).find(
    (entry) => entry.name === MIGRATION_NAME,
  );
  if (migration === undefined) {
    throw new StorageMigrationError("Prompt Surface V4 migration asset is missing");
  }

  const client = database.client;
  client.exec("PRAGMA foreign_keys = OFF");
  client.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of migration.sql) client.exec(statement);
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
    throw new StorageMigrationError("Prompt Surface V4 epoch rebuild failed", { cause: error });
  }
  client.exec("PRAGMA foreign_keys = ON");
  const integrity = client.prepare("PRAGMA foreign_key_check").all();
  if (integrity.length > 0) {
    throw new StorageMigrationError("Prompt Surface V4 foreign key verification failed");
  }
}
