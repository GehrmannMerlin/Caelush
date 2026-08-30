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
        "event_sequences",
        "tool_invocations",
      ]);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get()).toEqual({
        count: 4,
      });
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
