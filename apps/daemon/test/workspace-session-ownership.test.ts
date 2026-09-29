import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunId, createWorkspaceId } from "@caelush/protocol";
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

async function createApp() {
  root = await mkdtemp(join(tmpdir(), "caelush-workspace-session-"));
  storage = await openCaelushStorage({ path: join(root, "caelush.db") });
  const workspaceService = new WorkspaceService({
    repository: storage.workspaces,
    sessions: storage.sessions,
    runs: storage.runs,
    now: () => 100,
  });
  const app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    workspaces: storage.workspaces,
    workspaceService,
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
  const workspaceA = (await workspaceService.registerWorkspace({ path: root })).workspace;
  const workspaceBPath = await mkdtemp(join(root, "workspace-b-"));
  const workspaceB = (await workspaceService.registerWorkspace({ path: workspaceBPath })).workspace;
  return { app, workspaceService, workspaceA, workspaceB };
}

function jsonHeaders() {
  return { host: "127.0.0.1", "content-type": "application/json" };
}

const runInput = (workspace: { id: string; path: string }) => ({
  goal: "workspace-owned run",
  workspace,
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1_000 },
});

describe("Session workspace ownership", () => {
  it("requires a registered workspace for new production Sessions", async () => {
    const { app, workspaceA } = await createApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: jsonHeaders(),
      payload: { title: "owned", workspaceId: workspaceA.id },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      workspaceId: workspaceA.id,
      defaultWorkspace: { id: workspaceA.id, path: workspaceA.canonicalPath },
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: jsonHeaders(),
      payload: { title: "unbound" },
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it("returns only sessions owned by the requested Workspace", async () => {
    const { app, workspaceA, workspaceB } = await createApp();
    for (const workspace of [workspaceA, workspaceB]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: jsonHeaders(),
        payload: { workspaceId: workspace.id },
      });
      expect(response.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceA.id}/sessions`,
      headers: { host: "127.0.0.1" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].session.workspaceId).toBe(workspaceA.id);
    await app.close();
  });

  it("uses the Session Workspace as the Run authority and stores its canonical ref", async () => {
    const { app, workspaceA, workspaceB } = await createApp();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: jsonHeaders(),
      payload: { workspaceId: workspaceA.id },
    });
    const sessionId = session.json().id as string;

    const alias = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/runs`,
      headers: jsonHeaders(),
      payload: runInput({ id: workspaceA.id, path: join(workspaceA.canonicalPath, ".") }),
    });
    expect(alias.statusCode).toBe(201);
    expect(alias.json().workspace).toEqual({
      id: workspaceA.id,
      path: workspaceA.canonicalPath,
    });

    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/runs`,
      headers: jsonHeaders(),
      payload: runInput({ id: workspaceA.id, path: workspaceB.canonicalPath }),
    });
    expect(forged.statusCode).toBe(400);
    await app.close();
  });

  it("sorts Workspace Session summaries by Run activity and refuses active forgets", async () => {
    const { app, workspaceA } = await createApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: jsonHeaders(),
      payload: { workspaceId: workspaceA.id, title: "first" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: jsonHeaders(),
      payload: { workspaceId: workspaceA.id, title: "second" },
    });
    const firstRun = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${first.json().id}/runs`,
      headers: jsonHeaders(),
      payload: runInput({ id: workspaceA.id, path: workspaceA.canonicalPath }),
    });
    const secondRun = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${second.json().id}/runs`,
      headers: jsonHeaders(),
      payload: runInput({ id: workspaceA.id, path: workspaceA.canonicalPath }),
    });
    expect(firstRun.statusCode).toBe(201);
    expect(secondRun.statusCode).toBe(201);

    const firstRecord = await storage!.runs.get(firstRun.json().id);
    const secondRecord = await storage!.runs.get(secondRun.json().id);
    await storage!.runs.update({ ...firstRecord!, status: "COMPLETED", finishedAt: 300 });
    await storage!.runs.update({ ...secondRecord!, status: "RUNNING", startedAt: 400 });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceA.id}/sessions`,
      headers: { host: "127.0.0.1" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { session: { id: string } }) => item.session.id)).toEqual([
      second.json().id,
      first.json().id,
    ]);
    expect(list.json().items[0].latestRun.status).toBe("RUNNING");

    const blockedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceA.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json().error.code).toBe("ACTIVE_RUN_CONFLICT");

    const secondTerminal = await storage!.runs.get(secondRun.json().id);
    await storage!.runs.update({ ...secondTerminal!, status: "FAILED", finishedAt: 500 });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceA.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${first.json().id}`,
      headers: { host: "127.0.0.1" },
    })).statusCode).toBe(200);
    await app.close();
  });
});
