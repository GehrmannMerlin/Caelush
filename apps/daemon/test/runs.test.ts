import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@caelush/events";
import { createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function makeApp() {
  directory = await mkdtemp(join(tmpdir(), "caelush-run-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const eventBus = new EventBus(storage.events);
  const app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventBus,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
  return { app, eventBus };
}

const runInput = {
  goal: "Do the work",
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
};

async function createSession(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: {},
  });
  return response.json() as { id: string };
}

describe("run API", () => {
  it("creates a durable PENDING Run without publishing run.started", async () => {
    const { app } = await makeApp();
    const session = await createSession(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: runInput,
    });

    expect(response.statusCode).toBe(201);
    const run = response.json();
    expect(run).toMatchObject({ sessionId: session.id, goal: runInput.goal, status: "PENDING" });
    expect(run.id).toMatch(/^run_/);
    await expect(storage?.events.latestSequence(run.id)).resolves.toBe(0);
    await app.close();
  });

  it("gets and lists the same Run through the nested resource", async () => {
    const { app } = await makeApp();
    const session = await createSession(app);
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: runInput,
    });
    const run = create.json();

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${run.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(run);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: { host: "127.0.0.1" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [run] });
    await app.close();
  });

  it("rejects a missing parent and server-owned request fields", async () => {
    const { app } = await makeApp();
    const missingParent = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/ses_00000000-0000-7000-8000-000000000000/runs",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: runInput,
    });
    expect(missingParent.statusCode).toBe(404);

    for (const payload of [
      { ...runInput, id: "run_client" },
      { ...runInput, status: "RUNNING" },
      { ...runInput, sessionId: "other" },
    ]) {
      const session = await createSession(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/runs`,
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
    }
    await app.close();
  });
});
