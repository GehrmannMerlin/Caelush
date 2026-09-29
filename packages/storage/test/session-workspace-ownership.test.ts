import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";

let storage: CaelushStorage | undefined;
let root: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable Session Workspace ownership", () => {
  it("persists and indexes workspace_id independently of data_json", async () => {
    root = await mkdtemp(join(tmpdir(), "caelush-session-workspace-storage-"));
    storage = await openCaelushStorage({ path: join(root, "caelush.db") });
    const workspaceId = createWorkspaceId();
    const session = {
      id: createSessionId(),
      workspaceId,
      defaultWorkspace: { id: workspaceId, path: "D:/workspace" },
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    };

    await storage.sessions.insert(session);
    const columns = storage.sessions;
    expect(await columns.get(session.id)).toMatchObject({ workspaceId });
    expect(await columns.listByWorkspace(workspaceId)).toHaveLength(1);
  });
});
