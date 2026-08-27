import { createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteStepRepository } from "../src/repositories/step-repository.js";
import { StorageConflictError, StorageNotFoundError } from "../src/errors.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

async function createRepositories() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  return {
    database,
    sessions: new SqliteSessionRepository(database),
    runs: new SqliteRunRepository(database),
    steps: new SqliteStepRepository(database),
  };
}

describe("StepRepository", () => {
  it("persists steps and lists them by ascending sequence", async () => {
    const { database, sessions, runs, steps } = await createRepositories();
    const session = makeSession();
    const run = makeRun(session.id);
    const second = makeStep(run.id, { sequence: 2, startedAt: createTimestampMs(1) });
    const first = makeStep(run.id, { sequence: 1, startedAt: createTimestampMs(2) });
    await sessions.insert(session);
    await runs.insert(run);
    await steps.insert(second);
    await steps.insert(first);

    expect(await steps.get(first.id)).toEqual(first);
    expect(await steps.listByRun(run.id)).toEqual([first, second]);

    await database.close();
  });

  it("enforces the run foreign key and unique run sequence", async () => {
    const { database, steps } = await createRepositories();
    const step = makeStep(makeRun(makeSession().id).id);

    await expect(steps.insert(step)).rejects.toThrow();

    await database.close();
  });

  it("does not implicitly insert on update and rejects duplicate sequences", async () => {
    const { database, sessions, runs, steps } = await createRepositories();
    const session = makeSession();
    const run = makeRun(session.id);
    const step = makeStep(run.id);
    await sessions.insert(session);
    await runs.insert(run);
    await expect(steps.update(step)).rejects.toBeInstanceOf(StorageNotFoundError);
    await steps.insert(step);
    await expect(steps.insert(makeStep(run.id))).rejects.toBeInstanceOf(StorageConflictError);

    await database.close();
  });
});
