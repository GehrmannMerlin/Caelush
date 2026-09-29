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

/**
 * The recoverable-Run query.
 *
 * It exists so a fresh daemon can enumerate what a dead generation left behind without walking an
 * unbounded history. The three properties asserted here are the ones the reconciliation pass relies
 * on: only reconcilable statuses come back, a terminal Run can never come back, and the answer is
 * bounded and deterministically ordered.
 */
describe("RunRepository.listRecoverable", () => {
  it("returns non-terminal, non-pending Runs oldest-first and never a terminal one", async () => {
    const { database, sessions, runs } = await createRepositories();
    const session = makeSession();
    await sessions.insert(session);

    const pending = makeRun(session.id, { status: "PENDING", createdAt: createTimestampMs(1) });
    const running = makeRun(session.id, { status: "RUNNING", createdAt: createTimestampMs(2) });
    const verifying = makeRun(session.id, { status: "VERIFYING", createdAt: createTimestampMs(3) });
    const waiting = makeRun(session.id, {
      status: "WAITING_APPROVAL",
      createdAt: createTimestampMs(4),
    });
    const resource = makeRun(session.id, {
      status: "WAITING_RESOURCE",
      createdAt: createTimestampMs(5),
    });
    const completed = makeRun(session.id, { status: "COMPLETED", createdAt: createTimestampMs(6) });
    const failed = makeRun(session.id, { status: "FAILED", createdAt: createTimestampMs(7) });
    const cancelled = makeRun(session.id, { status: "CANCELLED", createdAt: createTimestampMs(8) });
    const timeout = makeRun(session.id, { status: "TIMEOUT", createdAt: createTimestampMs(9) });
    const maxSteps = makeRun(session.id, {
      status: "MAX_STEPS_REACHED",
      createdAt: createTimestampMs(10),
    });
    const budget = makeRun(session.id, {
      status: "BUDGET_EXCEEDED",
      createdAt: createTimestampMs(11),
    });

    for (const run of [
      pending,
      running,
      verifying,
      waiting,
      resource,
      completed,
      failed,
      cancelled,
      timeout,
      maxSteps,
      budget,
    ]) {
      await runs.insert(run);
    }

    const recoverable = await runs.listRecoverable();
    expect(recoverable.map((run) => run.id)).toEqual([
      running.id,
      verifying.id,
      waiting.id,
      resource.id,
    ]);
    expect(recoverable.map((run) => run.status)).toEqual([
      "RUNNING",
      "VERIFYING",
      "WAITING_APPROVAL",
      "WAITING_RESOURCE",
    ]);

    await database.close();
  });

  it("is bounded and deterministic for an identical database state", async () => {
    const { database, sessions, runs } = await createRepositories();
    const session = makeSession();
    await sessions.insert(session);
    for (let index = 1; index <= 5; index += 1) {
      await runs.insert(
        makeRun(session.id, { status: "RUNNING", createdAt: createTimestampMs(index) }),
      );
    }

    const first = await runs.listRecoverable({ limit: 3 });
    const second = await runs.listRecoverable({ limit: 3 });
    expect(first.map((run) => run.id)).toEqual(second.map((run) => run.id));
    expect(first).toHaveLength(3);
    expect((await runs.listRecoverable({ statuses: [] }))).toEqual([]);
    expect((await runs.listRecoverable({ limit: 0 }))).toEqual([]);

    await database.close();
  });
});
