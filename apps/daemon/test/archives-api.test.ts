import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { createSessionId, createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { buildDaemonApp } from "../src/app.js";
import { ArchiveService } from "../src/services/archive-service.js";
import { LegacyArchiveReconciler } from "../src/workspaces/legacy-archive-reconciler.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
const stores: CaelushStorage[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
async function fixture() {
  const storage = await openCaelushStorage({
    path: ":memory:",
    archivePolicy: { isTerminalRunStatus },
  });
  stores.push(storage);
  const stamp = createTimestampMs(1);
  const workspace = {
    id: createWorkspaceId(),
    canonicalPath: "D:/归档",
    displayName: "归档",
    createdAt: stamp,
    updatedAt: stamp,
    lastOpenedAt: stamp,
  };
  await storage.workspaces.insert(workspace);
  const session = {
    id: createSessionId(),
    workspaceId: workspace.id,
    title: "测试会话",
    createdAt: stamp,
    updatedAt: stamp,
    metadata: {},
  };
  await storage.sessions.insert(session);
  const invalidated: unknown[] = [];
  const archiveService = new ArchiveService({
    archives: storage.archives,
    reconciler: new LegacyArchiveReconciler(storage.archives),
    scopeId: "fixture",
    onDeleted: (commit) => {
      invalidated.push(commit);
    },
    now: () => 10,
  });
  const app = buildDaemonApp({
    archiveService,
    archives: storage.archives,
    sessions: storage.sessions,
    runs: storage.runs,
    workspaces: storage.workspaces,
    workspaceService: new WorkspaceService({
      repository: storage.workspaces,
      archives: storage.archives,
    }),
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15000 },
  });
  const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload === undefined ? {} : { payload }),
    });
  return { storage, workspace, session, invalidated, archiveService, app, request };
}
describe("archive management API", () => {
  it("supports archive, state, lists, restore, preview, delete and legacy workspace alias", async () => {
    const { app, request, session, workspace, invalidated } = await fixture();
    try {
      expect(
        (
          await request("POST", "/api/v1/archives/deletion-preview", {
            type: "SESSION",
            sessionId: session.id,
          })
        ).statusCode,
      ).toBe(409);
      const archived = await request("POST", `/api/v1/sessions/${session.id}/archive`, {});
      expect(archived.statusCode).toBe(200);
      expect(
        (await request("GET", `/api/v1/archives/state?type=SESSION&sessionId=${session.id}`)).json()
          .archived,
      ).toBe(true);
      expect((await request("GET", "/api/v1/archives/sessions")).json().matchedCount).toBe(1);
      expect(
        (
          await request("POST", `/api/v1/sessions/${session.id}/restore`, {
            archiveId: archived.json().state.ownArchive.archiveId,
          })
        ).statusCode,
      ).toBe(200);
      expect((await request("DELETE", `/api/v1/workspaces/${workspace.id}`)).statusCode).toBe(204);
      expect((await request("GET", "/api/v1/archives/workspaces")).json().matchedCount).toBe(1);
      const wsState = (
        await request("GET", `/api/v1/archives/state?type=WORKSPACE&workspaceId=${workspace.id}`)
      ).json();
      expect(
        (
          await request("POST", `/api/v1/workspaces/${workspace.id}/restore`, {
            archiveId: wsState.ownArchive.archiveId,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await request("POST", `/api/v1/workspaces/${workspace.id}/archive`, {})).statusCode,
      ).toBe(200);
      const preview = await request("POST", "/api/v1/archives/deletion-preview", {
        type: "WORKSPACE",
        workspaceId: workspace.id,
      });
      expect(preview.statusCode).toBe(200);
      const result = await request("POST", "/api/v1/archives/permanent-deletions", {
        confirmationToken: preview.json().confirmationToken,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().counts).toEqual({ workspaces: 1, sessions: 1, runs: 0 });
      expect(invalidated).toHaveLength(1);
      expect(
        (await request("GET", `/api/v1/archives/state?type=SESSION&sessionId=${session.id}`))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("rejects malformed shapes and imports only owned markers", async () => {
    const { app, request, session } = await fixture();
    try {
      expect(
        (
          await request("POST", "/api/v1/archives/legacy-import", {
            markers: [{ sessionId: session.id, archivedAt: null }],
          })
        ).json().importedSessionIds,
      ).toEqual([session.id]);
      for (const [url, payload] of [
        [`/api/v1/sessions/${session.id}/archive`, { dangerous: true }],
        ["/api/v1/archives/permanent-deletions", { confirmationToken: "tampered" }],
        [
          "/api/v1/archives/deletion-preview",
          {
            type: "SESSION_FILTER",
            filter: { query: "x", workspaceId: createWorkspaceId(), unassociated: true },
          },
        ],
      ] as const)
        expect((await request("POST", url, payload)).statusCode).toBe(400);
      expect(
        (
          await request(
            "GET",
            `/api/v1/archives/state?type=SESSION&sessionId=${session.id}&workspaceId=${createWorkspaceId()}`,
          )
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("previews all filtered pages and rejects stale confirmations without deleting anything", async () => {
    const { app, request, storage, session } = await fixture();
    try {
      for (let i = 0; i < 100; i++)
        await storage.sessions.insert({ ...session, id: createSessionId() });
      for (const target of await storage.sessions.list())
        await storage.archives.archive(
          { type: "SESSION", sessionId: target.id },
          createTimestampMs(1),
        );
      const preview = (
        await request("POST", "/api/v1/archives/deletion-preview", {
          type: "SESSION_FILTER",
          filter: {},
        })
      ).json();
      expect(preview.counts.sessions).toBe(101);
      expect(preview.samples.length).toBeLessThanOrEqual(3);
      const state = await storage.archives.getState({ type: "SESSION", sessionId: session.id });
      await storage.archives.restore(state.target, state.ownArchive!.archiveId);
      await storage.archives.archive(state.target, createTimestampMs(2));
      const stale = await request("POST", "/api/v1/archives/permanent-deletions", {
        confirmationToken: preview.confirmationToken,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("ARCHIVE_SELECTION_CHANGED");
      expect(await storage.sessions.list()).toHaveLength(101);
    } finally {
      await app.close();
    }
  });
});
