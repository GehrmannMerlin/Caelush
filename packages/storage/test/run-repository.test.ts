import { createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { StorageConflictError, StorageDecodeError, StorageNotFoundError } from "../src/errors.js";
import { makeRun, makeSession } from "./support/fixtures.js";

async function createRepositories() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  return {
    database,
    sessions: new SqliteSessionRepository(database),
    runs: new SqliteRunRepository(database),
  };
}

describe("RunRepository", () => {
  it("persists runs and lists them by session", async () => {
    const { database, sessions, runs } = await createRepositories();
    const session = makeSession();
    const first = makeRun(session.id, { createdAt: createTimestampMs(1) });
    const second = makeRun(session.id, { createdAt: createTimestampMs(2) });
    await sessions.insert(session);
    await runs.insert(first);
    await runs.insert(second);

    expect(await runs.get(first.id)).toEqual(first);
    expect(await runs.listBySession(session.id)).toEqual([second, first]);

    await database.close();
  });

  it("requires the parent session and keeps update separate from insert", async () => {
    const { database, runs } = await createRepositories();
    const run = makeRun(makeSession().id);

    await expect(runs.insert(run)).rejects.toThrow();
    await expect(runs.update(run)).rejects.toBeInstanceOf(StorageNotFoundError);

    await database.close();
  });

  it("rejects duplicate IDs and indexed-column corruption", async () => {
    const { database, sessions, runs } = await createRepositories();
    const session = makeSession();
    const run = makeRun(session.id);
    await sessions.insert(session);
    await runs.insert(run);
    await expect(runs.insert(run)).rejects.toBeInstanceOf(StorageConflictError);

    database.client
      .prepare("UPDATE agent_runs SET data_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...run, status: "RUNNING" }), run.id);
    await expect(runs.get(run.id)).rejects.toBeInstanceOf(StorageDecodeError);

    await database.close();
  });
});
