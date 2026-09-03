import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteMemoryRepository", () => {
  it("persists evidence-backed project memory across storage reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-memory-repository-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const first = await openCaelushStorage({ path: databasePath });
    const saved = await first.memory.save({
      scope: "PROJECT",
      projectId: "project-1",
      topic: "package manager",
      fact: "uses pnpm",
      confidence: 0.9,
      evidenceRefs: ["package.json"],
      sensitivity: "PUBLIC",
    });
    await first.close();

    const second = await openCaelushStorage({ path: databasePath });
    expect(await second.memory.get(saved.id)).toMatchObject({
      fact: "uses pnpm",
      status: "ACTIVE",
    });
    await second.close();
  });
});
