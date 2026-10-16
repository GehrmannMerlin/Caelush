import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import {
  createTimestampMs,
  createWorkspaceId,
  type ArchiveDeletionSelection,
} from "@caelush/protocol";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteArchiveStore } from "../src/archive/archive-store.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteWorkspaceRepository } from "../src/repositories/workspace-repository.js";
import {
  SqliteMemoryRepository,
  SqliteMemoryExtractionCommitStore,
} from "../src/memory-repository.js";
import { archiveGraph, graphTables } from "./fixtures/archive-graph.js";
import { makeSession } from "./support/fixtures.js";

const databases: Awaited<ReturnType<typeof openCaelushDatabase>>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  databases.push(database);
  await migrateCaelushDatabase(database);
  const store = new SqliteArchiveStore(database, { isTerminalRunStatus });
  return { database, store };
}
async function remove(store: SqliteArchiveStore, selection: ArchiveDeletionSelection) {
  return store.purge(selection, (await store.snapshotDeletion(selection)).digest);
}
function dump(database: Awaited<ReturnType<typeof openCaelushDatabase>>) {
  return graphTables.map((table) => [
    table,
    database.client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]);
}
describe("permanent archive purge", () => {
  it("removes the complete Session graph and preserves other records byte for byte", async () => {
    const { database, store } = await fixture();
    const other = await archiveGraph(database, "保留");
    const before = dump(database);
    const target = await archiveGraph(database, "删除");
    await store.archive({ type: "SESSION", sessionId: target.session.id }, createTimestampMs(10));
    const result = await remove(store, { type: "SESSION", sessionId: target.session.id });
    expect(result.response.counts).toEqual({ workspaces: 0, sessions: 1, runs: 1 });
    expect(dump(database)).toEqual(before);
    expect(
      await new SqliteWorkspaceRepository(database).getById(target.workspace.id),
    ).not.toBeNull();
    expect(await new SqliteSessionRepository(database).get(other.session.id)).not.toBeNull();
    expect(database.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await expect(
      store.purge({ type: "SESSION", sessionId: target.session.id }, "0".repeat(64)),
    ).rejects.toThrow();
    expect(dump(database)).toEqual(before);
  });
  it("deletes all Workspace children and re-registering the path restores no history", async () => {
    const { database, store } = await fixture();
    const target = await archiveGraph(database, "工作区");
    await new SqliteSessionRepository(database).insert(
      makeSession({ workspaceId: target.workspace.id }),
    );
    await store.archive(
      { type: "WORKSPACE", workspaceId: target.workspace.id },
      createTimestampMs(10),
    );
    expect(
      (await remove(store, { type: "WORKSPACE", workspaceId: target.workspace.id })).response
        .counts,
    ).toEqual({ workspaces: 1, sessions: 2, runs: 1 });
    expect(dump(database).every(([, rows]) => (rows as unknown[]).length === 0)).toBe(true);
    await new SqliteWorkspaceRepository(database).insert(target.workspace);
    expect(
      await new SqliteSessionRepository(database).listByWorkspace(target.workspace.id),
    ).toEqual([]);
  });
  it("confirms the entire filter across pages and rejects changed episodes and membership", async () => {
    const { database, store } = await fixture();
    const repo = new SqliteSessionRepository(database);
    const stamp = createTimestampMs(1);
    const workspaceId = createWorkspaceId();
    await new SqliteWorkspaceRepository(database).insert({
      id: workspaceId,
      canonicalPath: "D:/分页",
      displayName: "分页",
      createdAt: stamp,
      updatedAt: stamp,
      lastOpenedAt: stamp,
    });
    for (let i = 0; i < 101; i++) {
      const session = makeSession({ title: "命中 %_", workspaceId });
      await repo.insert(session);
      await store.archive({ type: "SESSION", sessionId: session.id }, createTimestampMs(10));
    }
    const selection = { type: "SESSION_FILTER" as const, filter: { query: "%_" } };
    const preview = await store.snapshotDeletion(selection);
    expect(preview.counts.sessions).toBe(101);
    const first = (await store.listSessions({ limit: 1 })).items[0]!;
    await store.restore(
      { type: "SESSION", sessionId: first.sessionId },
      first.state.ownArchive!.archiveId,
    );
    await store.archive({ type: "SESSION", sessionId: first.sessionId }, createTimestampMs(11));
    await expect(store.purge(selection, preview.digest)).rejects.toMatchObject({
      code: "ARCHIVE_SELECTION_CHANGED",
    });
    const next = await store.snapshotDeletion(selection);
    const extra = makeSession({ title: "新增 %_" });
    await repo.insert(extra);
    await store.archive({ type: "SESSION", sessionId: extra.id }, createTimestampMs(12));
    await expect(store.purge(selection, next.digest)).rejects.toMatchObject({
      code: "ARCHIVE_SELECTION_CHANGED",
    });
    expect((await remove(store, selection)).response.counts.sessions).toBe(102);
    expect(await repo.list()).toEqual([]);
  });
  it("rolls back every deletion on a late foreign key failure", async () => {
    const { database, store } = await fixture();
    const target = await archiveGraph(database, "回滚");
    await store.archive({ type: "SESSION", sessionId: target.session.id }, createTimestampMs(10));
    const before = dump(database);
    database.client.exec("CREATE TABLE deletion_blocker (run_id TEXT REFERENCES agent_runs(id))");
    database.client.prepare("INSERT INTO deletion_blocker VALUES (?)").run(target.run.id);
    await expect(
      remove(store, { type: "SESSION", sessionId: target.session.id }),
    ).rejects.toMatchObject({ errcode: 787 });
    expect(dump(database)).toEqual(before);
    expect((await store.getState({ type: "SESSION", sessionId: target.session.id })).archived).toBe(
      true,
    );
  });
  it("rejects mixed facts even when remaining Run IDs exist, without deleting any records", async () => {
    const { database, store } = await fixture();
    const target = await archiveGraph(database, "来源一");
    const other = await archiveGraph(database, "来源二");
    const memory = new SqliteMemoryRepository(database);
    const record = await memory.save({
      scope: "GLOBAL",
      topic: "fact",
      fact: "A-only private detail and B-only public detail.",
      confidence: 1,
      evidenceRefs: [`run:${target.run.id}`, `run:${other.run.id}`],
      sourceRunIds: [target.run.id, other.run.id],
      sensitivity: "INTERNAL",
    });
    const exclusive = await memory.save({
      scope: "GLOBAL",
      topic: "old fact",
      fact: "An older strict mode rule.",
      confidence: 1,
      evidenceRefs: [`run:${target.run.id}`],
      sourceRunIds: [target.run.id],
      sensitivity: "INTERNAL",
    });
    await memory.supersede(exclusive.id, record.id);
    await store.archive({ type: "SESSION", sessionId: target.session.id }, createTimestampMs(10));
    const before = dump(database);
    await expect(
      remove(store, { type: "SESSION", sessionId: target.session.id }),
    ).rejects.toMatchObject({ code: "DATA_OWNERSHIP_CONFLICT" });
    expect(dump(database)).toEqual(before);
    expect(await memory.get(record.id)).toMatchObject({
      fact: "A-only private detail and B-only public detail.",
      sourceRunIds: [target.run.id, other.run.id],
      evidenceRefs: [`run:${target.run.id}`, `run:${other.run.id}`],
    });
    expect(await memory.get(exclusive.id)).toBeDefined();
  });
  it("aborts ambiguous mixed memory ownership without partial effects", async () => {
    const { database, store } = await fixture();
    const target = await archiveGraph(database, "冲突");
    const other = await archiveGraph(database, "来源");
    const memory = new SqliteMemoryRepository(database);
    await memory.save({
      scope: "GLOBAL",
      topic: "fact",
      fact: "Use strict mode.",
      confidence: 1,
      evidenceRefs: ["unknown"],
      sourceRunIds: [target.run.id, other.run.id],
      sensitivity: "INTERNAL",
    });
    await store.archive({ type: "SESSION", sessionId: target.session.id }, createTimestampMs(10));
    const before = dump(database);
    await expect(
      remove(store, { type: "SESSION", sessionId: target.session.id }),
    ).rejects.toMatchObject({ code: "DATA_OWNERSHIP_CONFLICT" });
    expect(dump(database)).toEqual(before);
  });
  it("fences extraction whichever transaction commits first", async () => {
    for (const first of ["MEMORY", "DELETE"]) {
      const { database, store } = await fixture();
      const target = await archiveGraph(database, first);
      const commit = new SqliteMemoryExtractionCommitStore(database);
      const input = {
        jobId: `${first}:job`,
        attempt: 1,
        candidates: [
          {
            scope: "PROJECT" as const,
            topic: "fact",
            fact: "Use strict mode.",
            confidence: 1,
            evidenceRefs: [`run:${target.run.id}`],
            sensitivity: "INTERNAL" as const,
          },
        ],
        now: 2,
      };
      if (first === "MEMORY") expect(await commit.commit(input)).toBe("COMMITTED");
      await store.archive(
        { type: "WORKSPACE", workspaceId: target.workspace.id },
        createTimestampMs(10),
      );
      await remove(store, { type: "WORKSPACE", workspaceId: target.workspace.id });
      expect(await commit.commit(input)).toBe("STALE");
      expect(await new SqliteMemoryRepository(database).list()).toEqual([]);
    }
  });
});
