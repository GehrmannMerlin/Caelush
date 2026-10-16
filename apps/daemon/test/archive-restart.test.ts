import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CaelushClient } from "@caelush/client";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";

it.each([false, true])(
  "restarts with an archived compatibility workspace without restoring it (directory moved: %s)",
  async (moved) => {
    const root = resolve(tmpdir(), `caelush-archive-restart-${randomUUID()}`);
    const project = join(root, "中文 project");
    await mkdir(project, { recursive: true });
    const options = { databasePath: join(root, "caelush.db"), port: 0, workspacePath: project };
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon(options);
      let client = new CaelushClient({ baseUrl: daemon.url });
      const workspace = (await client.listWorkspaces()).items[0]!;
      const session = await client.createSession({ workspaceId: workspace.id, title: "保留归档" });
      const archived = await client.archiveWorkspace(workspace.id);
      const before = await client.getWorkspace(workspace.id);
      await daemon.close();
      daemon = undefined;
      if (moved) {
        const destination = join(root, "moved project");
        expect(dirname(resolve(project))).toBe(root);
        expect(dirname(resolve(destination))).toBe(root);
        await rename(project, destination);
      }

      daemon = await startDaemon(options);
      client = new CaelushClient({ baseUrl: daemon.url });
      expect(await client.getWorkspace(workspace.id)).toEqual(before);
      expect(
        (await client.getArchiveState({ type: "WORKSPACE", workspaceId: workspace.id })).ownArchive,
      ).toEqual(archived.state.ownArchive);
      expect((await client.listWorkspaces()).items).toEqual([]);
      expect((await client.listArchivedSessions()).items.map((item) => item.sessionId)).toEqual([
        session.id,
      ]);
      if (!moved)
        await expect(client.createWorkspace({ path: project })).rejects.toMatchObject({
          code: "WORKSPACE_ARCHIVED",
        });
    } finally {
      await daemon?.close();
      // The only recursive target is this test's exact, newly allocated UUID root.
      expect(
        root.startsWith(`${resolve(tmpdir())}\\`) || root.startsWith(`${resolve(tmpdir())}/`),
      ).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("reconciles forgotten history before registering a remembered launch path", async () => {
  const root = resolve(tmpdir(), `caelush-archive-restart-${randomUUID()}`);
  const project = join(root, "forgotten 中文");
  await mkdir(project, { recursive: true });
  const options = { databasePath: join(root, "caelush.db"), port: 0, workspacePath: project };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon(options);
    let client = new CaelushClient({ baseUrl: daemon.url });
    const workspace = (await client.listWorkspaces()).items[0]!;
    const session = await client.createSession({ workspaceId: workspace.id });
    await daemon.close();
    daemon = undefined;
    // Simulate the historical physical registry removal; preserve the original Session data.
    const database = new DatabaseSync(options.databasePath);
    try {
      database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    } finally {
      database.close();
    }
    daemon = await startDaemon(options);
    client = new CaelushClient({ baseUrl: daemon.url });
    expect((await client.listWorkspaces()).items).toEqual([]);
    const state = await client.getArchiveState({ type: "SESSION", sessionId: session.id });
    expect(state.archived).toBe(true);
    expect(state.parentWorkspace?.archive).toMatchObject({
      reason: "LEGACY_FORGOTTEN_WORKSPACE",
      archivedAt: null,
    });
  } finally {
    await daemon?.close();
    expect(dirname(root)).toBe(resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
