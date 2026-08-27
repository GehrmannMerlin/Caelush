import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

describe("SQLite integrity", () => {
  it("keeps a migrated file database consistent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-integrity-"));
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    await storage.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
