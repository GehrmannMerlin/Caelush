import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

let storage: CaelushStorage | undefined;
let root: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createApp(picker?: { pick: () => Promise<unknown> }) {
  root = await mkdtemp(join(tmpdir(), "caelush-workspace-api-"));
  storage = await openCaelushStorage({ path: join(root, "caelush.db") });
  return buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    workspaces: storage.workspaces,
    workspaceService: new WorkspaceService({ repository: storage.workspaces, now: () => 100 }),
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
    ...(picker === undefined ? {} : { workspacePicker: picker as never }),
  });
}

describe("Workspace API", () => {
  it("registers idempotently and exposes CRUD through the daemon", async () => {
    const app = await createApp();
    const project = await mkdtemp(join(root!, "project-"));
    const headers = { host: "127.0.0.1", "content-type": "application/json" };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers,
      payload: { path: project },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers,
      payload: { path: join(project, ".") },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const id = first.json().id as string;
    await expect(
      app.inject({ method: "GET", url: `/api/v1/workspaces/${id}`, headers }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/workspaces", headers }),
    ).resolves.toMatchObject({ statusCode: 200 });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${id}`,
      headers: { host: headers.host },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      await app.inject({ method: "GET", url: `/api/v1/workspaces/${id}`, headers }),
    ).toMatchObject({
      statusCode: 404,
    });

    await app.close();
  });

  it("returns the directory selected by the native workspace picker", async () => {
    const app = await createApp({
      pick: async () => ({ status: "SELECTED", path: "D:\\Develop\\Caelush" }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/pick",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "SELECTED",
      path: "D:\\Develop\\Caelush",
    });
    await app.close();
  });
});
