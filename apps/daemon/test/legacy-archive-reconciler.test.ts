import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { createSessionId, createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import * as reconcilerModule from "../src/workspaces/legacy-archive-reconciler.js";
import {
  createStableWorkspaceId,
  normalizeWorkspaceIdentityPath,
} from "../src/workspaces/workspace-identity.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { backfillSessionWorkspaceOwnership } from "../src/workspaces/workspace-backfill.js";
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
  return storage;
}
describe("legacy missing Workspace archive reconciliation", () => {
  it("preserves Windows root identity and ignores archived Sessions during startup backfill", async () => {
    expect(normalizeWorkspaceIdentityPath("D:/")).toBe("d:/");
    expect(createStableWorkspaceId("D:/项目/Case")).toBe(createStableWorkspaceId("d:/项目/case"));
    const storage = await fixture();
    const stamp = createTimestampMs(1);
    const legacy = {
      id: createSessionId(),
      defaultWorkspace: { id: createStableWorkspaceId(process.cwd()), path: process.cwd() },
      createdAt: stamp,
      updatedAt: stamp,
      metadata: {},
    };
    await storage.sessions.insert(legacy);
    await storage.archives.archive({ type: "SESSION", sessionId: legacy.id }, stamp);
    await expect(
      backfillSessionWorkspaceOwnership({
        archives: storage.archives,
        sessions: storage.sessions,
        runs: storage.runs,
        workspaceService: new WorkspaceService({
          repository: storage.workspaces,
          archives: storage.archives,
        }),
      }),
    ).resolves.toMatchObject({ unbound: 1 });
    expect(await storage.sessions.get(legacy.id)).toEqual(legacy);
  });
  it("restores archived metadata from missing directories without touching the filesystem", async () => {
    const storage = await fixture();
    const stamp = createTimestampMs(1);
    for (const path of ["D:/不存在/中文 项目", "d:/NOT-PRESENT/Same", "D:/另一目录/Same"]) {
      const id = createStableWorkspaceId(path);
      await storage.sessions.insert({
        id: createSessionId(),
        workspaceId: id,
        defaultWorkspace: { id, path },
        createdAt: stamp,
        updatedAt: stamp,
        metadata: {},
      });
    }
    const ordinary = { id: createSessionId(), createdAt: stamp, updatedAt: stamp, metadata: {} };
    await storage.sessions.insert(ordinary);
    const reconciler = new reconcilerModule.LegacyArchiveReconciler(storage.archives);
    expect((await reconciler.reconcile()).migratedSessionIds).toHaveLength(3);
    const items = (await storage.archives.listWorkspaces({ limit: 50 })).items;
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.archivedAt === null)).toBe(true);
    expect(items.map((i) => i.workspace.canonicalPath)).toContain(
      normalizeWorkspaceIdentityPath("D:/不存在/中文 项目"),
    );
    expect(
      (await storage.archives.getState({ type: "SESSION", sessionId: ordinary.id })).archived,
    ).toBe(false);
    expect((await reconciler.reconcile()).migratedSessionIds).toEqual([]);
  });
  it("keeps conflicting stable IDs unassociated and preserves their original refs", async () => {
    const storage = await fixture();
    const stamp = createTimestampMs(1);
    const id = createWorkspaceId();
    const session = {
      id: createSessionId(),
      workspaceId: id,
      defaultWorkspace: { id, path: "D:/不能证明" },
      createdAt: stamp,
      updatedAt: stamp,
      metadata: {},
    };
    await storage.sessions.insert(session);
    await new reconcilerModule.LegacyArchiveReconciler(storage.archives).reconcile();
    const item = (await storage.archives.listSessions({ limit: 50 })).items[0]!;
    expect(item.group.key).toBe("UNASSOCIATED");
    expect(item.state.restoreDisposition).toBe("WORKSPACE_UNAVAILABLE");
    expect(await storage.sessions.get(session.id)).toEqual(session);
    expect(await storage.workspaces.list()).toEqual([]);
  });
});
