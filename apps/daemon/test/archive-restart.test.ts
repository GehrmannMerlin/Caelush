import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CaelushClient } from "@caelush/client";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";

it("restarts with an archived compatibility workspace without restoring or touching it", async () => {
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
}, 30_000);
