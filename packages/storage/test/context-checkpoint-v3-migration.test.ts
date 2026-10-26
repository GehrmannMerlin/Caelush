import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Context Checkpoint V3 schema migration", () => {
  it("supports session ownership and multi-range rows without rewriting V1/V2 sequence data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-checkpoint-v3-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");

    const storage = await openCaelushStorage({ path: databasePath });
    await storage.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      const columns = sqlite.prepare("PRAGMA table_info('context_checkpoints')").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const byName = new Map(columns.map((column) => [column.name, column]));

      expect(byName.has("session_id")).toBe(true);
      expect(byName.has("owner_step_sequence")).toBe(true);
      expect(byName.has("activation_operation_id")).toBe(true);
      expect(byName.has("coverage_digest")).toBe(true);
      expect(byName.get("source_sequence_from")?.notnull).toBe(0);
      expect(byName.get("source_sequence_to")?.notnull).toBe(0);

      const createSql = sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_checkpoints'",
        )
        .get() as { sql: string } | undefined;
      const normalizedSql = createSql?.sql.replaceAll("`", "");
      expect(normalizedSql).toContain("summary_version IN (1, 2)");
      expect(normalizedSql).toContain("summary_version = 3");
    } finally {
      sqlite.close();
    }
  });
});
