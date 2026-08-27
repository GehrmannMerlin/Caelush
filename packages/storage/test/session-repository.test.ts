import { describe, expect, it } from "vitest";
import { AgentSessionSchema, createTimestampMs } from "@caelush/protocol";
import { openCaelushDatabase } from "../src/database.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { StorageConflictError, StorageDecodeError, StorageNotFoundError } from "../src/errors.js";
import { makeSession } from "./support/fixtures.js";
import { migrateCaelushDatabase } from "../src/migrate.js";

async function createRepository() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  return { database, repository: new SqliteSessionRepository(database) };
}

describe("SessionRepository", () => {
  it("inserts, gets, updates, and lists sessions", async () => {
    const { database, repository } = await createRepository();
    const older = makeSession({
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(10),
    });
    const newer = makeSession({
      createdAt: createTimestampMs(2),
      updatedAt: createTimestampMs(20),
    });

    await repository.insert(older);
    await repository.insert(newer);
    await repository.update({ ...older, title: "updated", updatedAt: createTimestampMs(30) });

    expect(await repository.get(older.id)).toEqual({
      ...older,
      title: "updated",
      updatedAt: createTimestampMs(30),
    });
    expect(await repository.list()).toEqual([
      { ...older, title: "updated", updatedAt: createTimestampMs(30) },
      newer,
    ]);

    await database.close();
  });

  it("does not turn update or duplicate insert into an implicit upsert", async () => {
    const { database, repository } = await createRepository();
    const session = makeSession();

    await expect(repository.update(session)).rejects.toBeInstanceOf(StorageNotFoundError);
    await repository.insert(session);
    await expect(repository.insert(session)).rejects.toBeInstanceOf(StorageConflictError);

    await database.close();
  });

  it("fails fast when stored JSON or indexed columns are corrupted", async () => {
    const { database, repository } = await createRepository();
    const session = makeSession();
    await repository.insert(session);

    database.client
      .prepare("UPDATE agent_sessions SET data_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...session, id: "corrupted" }), session.id);

    await expect(repository.get(session.id)).rejects.toBeInstanceOf(StorageDecodeError);

    database.client
      .prepare("UPDATE agent_sessions SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(session), session.id);
    database.client
      .prepare("UPDATE agent_sessions SET protocol_version = ? WHERE id = ?")
      .run(2, session.id);
    expect(() => AgentSessionSchema.parse(session)).not.toThrow();
    await expect(repository.get(session.id)).rejects.toBeInstanceOf(StorageDecodeError);

    await database.close();
  });
});
