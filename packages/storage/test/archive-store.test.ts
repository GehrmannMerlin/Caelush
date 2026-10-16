import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import {
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentSession,
  type WorkspaceRecord,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { openCaelushDatabase } from "../src/database.js";

const resources: { root: string; storage: CaelushStorage }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.storage.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "caelush-archive-store-"));
  const path = join(root, "archive.db");
  const storage = await openCaelushStorage({ path, archivePolicy: { isTerminalRunStatus } });
  resources.push({ root, storage });
  expect(storage.archives, "Storage must expose durable archives").toBeDefined();
  const stamp = createTimestampMs(1);
  const workspace: WorkspaceRecord = {
    id: createWorkspaceId(),
    canonicalPath: "D:/中文 项目",
    displayName: "中文 项目",
    createdAt: stamp,
    updatedAt: stamp,
    lastOpenedAt: stamp,
  };
  await storage.workspaces.insert(workspace);
  async function session(title: string): Promise<AgentSession> {
    const item: AgentSession = {
      id: createSessionId(),
      workspaceId: workspace.id,
      defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
      title,
      createdAt: stamp,
      updatedAt: stamp,
      metadata: {},
    };
    await storage.sessions.insert(item);
    return item;
  }
  return { storage, root, path, workspace, session, archives: storage.archives };
}

describe("durable archive management", () => {
  it("restores a Workspace without restoring independently archived Sessions", async () => {
    const { archives, workspace, session, storage } = await fixture();
    const A = await session("independent");
    const B = await session("normal");
    await archives.archive({ type: "SESSION", sessionId: A.id }, createTimestampMs(10));
    const parent = await archives.archive(
      { type: "WORKSPACE", workspaceId: workspace.id },
      createTimestampMs(20),
    );
    expect(await archives.listActiveSessions({})).toHaveLength(0);
    expect((await archives.listSessions({ limit: 50 })).matchedCount).toBe(2);
    expect((await archives.getState({ type: "SESSION", sessionId: B.id })).restoreDisposition).toBe(
      "PARENT_ARCHIVED",
    );
    await archives.restore(
      { type: "WORKSPACE", workspaceId: workspace.id },
      parent.state.ownArchive!.archiveId,
    );
    expect((await archives.listActiveSessions({})).map((s) => s.id)).toEqual([B.id]);
    expect((await archives.getState({ type: "SESSION", sessionId: A.id })).archived).toBe(true);
    expect(await storage.sessions.list()).toHaveLength(2);
  });

  it("keeps duplicate archive requests stable and rejects stale restoration", async () => {
    const { archives, session } = await fixture();
    const A = await session("A");
    const target = { type: "SESSION" as const, sessionId: A.id };
    const first = await archives.archive(target, createTimestampMs(10));
    const duplicate = await archives.archive(target, createTimestampMs(20));
    expect(duplicate.changed).toBe(false);
    expect(duplicate.state.ownArchive).toEqual(first.state.ownArchive);
    await archives.restore(target, first.state.ownArchive!.archiveId);
    await archives.archive(target, createTimestampMs(30));
    await expect(archives.restore(target, first.state.ownArchive!.archiveId)).rejects.toMatchObject(
      { code: "ARCHIVE_SELECTION_CHANGED" },
    );
  });

  it("persists episodes across reopen and keeps valid foreign keys", async () => {
    const { archives, storage, path, session } = await fixture();
    const A = await session("A");
    const target = { type: "SESSION" as const, sessionId: A.id };
    const result = await archives.archive(target, createTimestampMs(10));
    await storage.close();
    const reopened = await openCaelushStorage({ path, archivePolicy: { isTerminalRunStatus } });
    resources[resources.length - 1]!.storage = reopened;
    expect((await reopened.archives.getState(target)).ownArchive).toEqual(result.state.ownArchive);
    const database = await openCaelushDatabase({ path });
    expect(database.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("counts and paginates all inherited archives and searches literally", async () => {
    const { archives, workspace, session } = await fixture();
    for (let index = 0; index < 101; index++)
      await session(index === 0 ? "中文 100%_" : `Conversation ${index}`);
    await archives.archive({ type: "WORKSPACE", workspaceId: workspace.id }, createTimestampMs(10));
    const page = await archives.listSessions({ limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.matchedCount).toBe(101);
    expect(page.totalCounts).toEqual({ sessions: 101, workspaces: 1 });
    const next = await archives.listSessions({ limit: 100, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(1);
    expect(new Set([...page.items, ...next.items].map((s) => s.sessionId)).size).toBe(101);
    expect(
      (await archives.listSessions({ limit: 50, query: "%_" })).items.map((s) => s.title),
    ).toEqual(["中文 100%_"]);
    expect((await archives.listSessions({ limit: 50, query: "CONVERSATION 1" })).matchedCount).toBe(
      12,
    );
  });

  it("rejects a cursor after the archive catalog changes", async () => {
    const { archives, workspace, session } = await fixture();
    await session("A");
    await session("B");
    const target = { type: "WORKSPACE" as const, workspaceId: workspace.id };
    const archived = await archives.archive(target, createTimestampMs(10));
    const page = await archives.listSessions({ limit: 1 });
    await archives.restore(target, archived.state.ownArchive!.archiveId);
    await expect(
      archives.listSessions({ limit: 1, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIST_CHANGED" });
  });

  it("keeps historical unknown timestamps archived and ordered last", async () => {
    const { archives, path, session } = await fixture();
    const A = await session("unknown");
    const B = await session("known");
    await archives.archive({ type: "SESSION", sessionId: A.id }, createTimestampMs(10));
    await archives.archive({ type: "SESSION", sessionId: B.id }, createTimestampMs(20));
    const database = await openCaelushDatabase({ path });
    database.client
      .prepare("UPDATE session_archives SET archived_at_ms = NULL WHERE session_id = ?")
      .run(A.id);
    database.close();
    const page = await archives.listSessions({ limit: 50 });
    expect(page.items.map((s) => s.title)).toEqual(["known", "unknown"]);
    expect(page.items[1]!.archivedAt).toBeNull();
    expect(page.items[1]!.state.archived).toBe(true);
  });
});
