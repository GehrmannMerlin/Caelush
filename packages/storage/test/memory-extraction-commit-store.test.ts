import { afterEach, describe, expect, it } from "vitest";
import type { MemoryCandidate } from "@caelush/memory";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import * as memoryAdapters from "../src/memory-repository.js";
import { SqliteMemoryExtractionJobRepository } from "../src/memory-extraction-job-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const databases: Awaited<ReturnType<typeof openCaelushDatabase>>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const candidate: MemoryCandidate = {
  scope: "GLOBAL",
  projectId: "untrusted",
  topic: "style",
  fact: "Use strict TypeScript.",
  confidence: 1,
  evidenceRefs: ["source"],
  sourceRunIds: ["untrusted"],
  sensitivity: "INTERNAL",
};
async function fixture(projectMismatch = false) {
  const database = await openCaelushDatabase({ path: ":memory:" });
  databases.push(database);
  await migrateCaelushDatabase(database);
  const session = makeSession();
  await new SqliteSessionRepository(database).insert(session);
  const run = makeRun(session.id, { status: "COMPLETED" });
  await new SqliteRunRepository(database).insert(run);
  const jobs = new SqliteMemoryExtractionJobRepository(database);
  const job = await jobs.createOrGet({
    id: "job-1",
    sourceRunId: run.id,
    projectId: projectMismatch ? "wrong" : run.workspace.id,
    createdAt: 1,
  });
  const claimed = (await jobs.claim(job.id, 2))!;
  return {
    database,
    run,
    jobs,
    claimed,
    commit: new memoryAdapters.SqliteMemoryExtractionCommitStore(database),
    memory: new memoryAdapters.SqliteMemoryRepository(database),
  };
}
describe("atomic memory extraction commit", () => {
  it("commits a validated batch with authoritative source ownership", async () => {
    const { run, jobs, claimed, commit, memory } = await fixture();
    expect(
      await commit.commit({
        jobId: claimed.id,
        attempt: claimed.attempt,
        candidates: [candidate],
        now: 3,
      }),
    ).toBe("COMMITTED");
    expect(await memory.list()).toMatchObject([
      { scope: "PROJECT", projectId: run.workspace.id, sourceRunIds: [run.id] },
    ]);
    expect((await jobs.get(claimed.id))?.status).toBe("COMPLETED");
  });
  it("ignores a deleted source and never resurrects its job", async () => {
    const { database, run, jobs, claimed, commit, memory } = await fixture();
    database.client.prepare("DELETE FROM memory_extraction_jobs WHERE id = ?").run(claimed.id);
    database.client.prepare("DELETE FROM agent_runs WHERE id = ?").run(run.id);
    expect(
      await commit.commit({
        jobId: claimed.id,
        attempt: claimed.attempt,
        candidates: [candidate],
        now: 3,
      }),
    ).toBe("STALE");
    expect(await memory.list()).toEqual([]);
    expect(await jobs.get(claimed.id)).toBeUndefined();
    expect(await jobs.fail(claimed.id, 4, "failed", claimed.attempt)).toBeUndefined();
  });
  it("ignores an old attempt and mismatched source project", async () => {
    for (const mismatch of [false, true]) {
      const { jobs, claimed, commit, memory } = await fixture(mismatch);
      expect(
        await commit.commit({
          jobId: claimed.id,
          attempt: mismatch ? claimed.attempt : claimed.attempt - 1,
          candidates: [candidate],
          now: 3,
        }),
      ).toBe("STALE");
      expect(await memory.list()).toEqual([]);
      expect((await jobs.get(claimed.id))?.status).toBe("RUNNING");
      expect(await jobs.fail(claimed.id, 4, "old", claimed.attempt - 1)).toBeUndefined();
    }
  });
  it("rolls back the batch and completion when any candidate is invalid", async () => {
    const { jobs, claimed, commit, memory } = await fixture();
    await expect(
      commit.commit({
        jobId: claimed.id,
        attempt: claimed.attempt,
        candidates: [candidate, { ...candidate, fact: "invalid", evidenceRefs: [] }],
        now: 3,
      }),
    ).rejects.toThrow();
    expect(await memory.list()).toEqual([]);
    expect((await jobs.get(claimed.id))?.status).toBe("RUNNING");
  });
});
