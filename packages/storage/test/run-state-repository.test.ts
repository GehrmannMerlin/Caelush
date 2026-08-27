import { createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteRunStateRepository } from "../src/repositories/run-state-repository.js";
import { StorageDecodeError } from "../src/errors.js";
import { makeRun, makeSession, makeState } from "./support/fixtures.js";

async function createRepositories() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  return {
    database,
    sessions: new SqliteSessionRepository(database),
    runs: new SqliteRunRepository(database),
    states: new SqliteRunStateRepository(database),
  };
}

describe("RunStateRepository", () => {
  it("saves a first snapshot at revision 1 and increments subsequent saves", async () => {
    const { database, sessions, runs, states } = await createRepositories();
    const session = makeSession();
    const run = makeRun(session.id);
    const state = makeState(run);
    await sessions.insert(session);
    await runs.insert(run);

    expect(await states.save(state)).toEqual({ state, revision: 1 });
    const updated = { ...state, updatedAt: createTimestampMs(200), status: "RUNNING" as const };
    expect(await states.save(updated)).toEqual({ state: updated, revision: 2 });
    expect(await states.get(run.id)).toEqual(updated);

    await database.close();
  });

  it("requires an existing run and fails fast for corrupted snapshots", async () => {
    const { database, states, sessions, runs } = await createRepositories();
    const missing = makeState(makeRun(makeSession().id));
    await expect(states.save(missing)).rejects.toThrow();

    const session = makeSession();
    const run = makeRun(session.id);
    await sessions.insert(session);
    await runs.insert(run);
    await states.save(makeState(run));
    database.client
      .prepare("UPDATE agent_state_snapshots SET data_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ runId: run.id }), run.id);

    await expect(states.get(run.id)).rejects.toBeInstanceOf(StorageDecodeError);
    await database.close();
  });
});
