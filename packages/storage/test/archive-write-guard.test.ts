import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { createTimestampMs, createWorkspaceId, type RunStatus } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];
afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close();
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
    canonicalPath: "D:/archive",
    displayName: "archive",
    createdAt: stamp,
    updatedAt: stamp,
    lastOpenedAt: stamp,
  };
  await storage.workspaces.insert(workspace);
  const session = makeSession({
    workspaceId: workspace.id,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
  });
  await storage.sessions.insert(session);
  return { storage, session, workspace, ref: { id: workspace.id, path: workspace.canonicalPath } };
}

describe("archive write admission", () => {
  it.each<RunStatus>(["PENDING", "RUNNING", "WAITING_APPROVAL", "WAITING_RESOURCE", "VERIFYING"])(
    "refuses to archive a %s Run",
    async (status) => {
      const { storage, session, workspace, ref } = await fixture();
      await storage.runs.insert(makeRun(session.id, { status, workspace: ref }));
      for (const target of [
        { type: "SESSION" as const, sessionId: session.id },
        { type: "WORKSPACE" as const, workspaceId: workspace.id },
      ]) {
        await expect(storage.archives.archive(target, createTimestampMs(10))).rejects.toMatchObject(
          { code: "ACTIVE_RUN_CONFLICT" },
        );
        expect((await storage.archives.getState(target)).archived).toBe(false);
      }
    },
  );

  it("refuses Session modifications after archive", async () => {
    const { storage, session } = await fixture();
    await storage.archives.archive(
      { type: "SESSION", sessionId: session.id },
      createTimestampMs(10),
    );
    await expect(storage.sessions.update({ ...session, title: "changed" })).rejects.toMatchObject({
      code: "OBJECT_ARCHIVED",
    });
    expect((await storage.sessions.get(session.id))?.title).toBeUndefined();
  });

  it("refuses new Runs and creation events after archive", async () => {
    const { storage, session, ref } = await fixture();
    await storage.archives.archive(
      { type: "SESSION", sessionId: session.id },
      createTimestampMs(10),
    );
    await expect(
      storage.runs.insert(makeRun(session.id, { workspace: ref })),
    ).rejects.toMatchObject({ code: "OBJECT_ARCHIVED" });
    await expect(
      storage.runs.insertWithEvents!(makeRun(session.id, { workspace: ref }), []),
    ).rejects.toMatchObject({ code: "OBJECT_ARCHIVED" });
    expect(await storage.runs.listBySession(session.id)).toEqual([]);
  });

  it("refuses insertion into an archived Workspace", async () => {
    const { storage, workspace, ref } = await fixture();
    await storage.archives.archive(
      { type: "WORKSPACE", workspaceId: workspace.id },
      createTimestampMs(10),
    );
    await expect(
      storage.sessions.insert(makeSession({ workspaceId: workspace.id, defaultWorkspace: ref })),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
  });

  it("cannot reopen a terminal Run by writing after archive", async () => {
    const { storage, session, ref } = await fixture();
    const run = makeRun(session.id, { workspace: ref, status: "COMPLETED" });
    await storage.runs.insert(run);
    await storage.archives.archive(
      { type: "SESSION", sessionId: session.id },
      createTimestampMs(10),
    );
    await expect(storage.runs.update({ ...run, status: "RUNNING" })).rejects.toMatchObject({
      code: "OBJECT_ARCHIVED",
    });
    expect((await storage.runs.get(run.id))?.status).toBe("COMPLETED");
  });
});
