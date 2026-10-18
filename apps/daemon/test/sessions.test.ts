import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { SessionService } from "../src/services/session-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function makeApp() {
  directory = await mkdtemp(join(tmpdir(), "caelush-session-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  return buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
}

describe("session API", () => {
  it("creates, gets, and lists a Session from SQLite", async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { title: "Work", metadata: { source: "test" } },
    });

    expect(create.statusCode).toBe(201);
    const session = create.json();
    expect(session).toMatchObject({ title: "Work", metadata: { source: "test" } });
    expect(session.id).toMatch(/^ses_/);
    expect(typeof session.createdAt).toBe("number");
    expect(session.updatedAt).toBe(session.createdAt);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(session);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/sessions?limit=50",
      headers: { host: "127.0.0.1" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [session] });
    await app.close();
  });

  it("fills omitted metadata with an empty object", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().metadata).toEqual({});
    await app.close();
  });

  it("rejects server-owned and unknown fields", async () => {
    const app = await makeApp();
    for (const payload of [{ id: "ses_client" }, { createdAt: 1 }, { unknown: true }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
    }
    await app.close();
  });

  it("returns 404 for a missing Session", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/ses_00000000-0000-7000-8000-000000000000",
      headers: { host: "127.0.0.1" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("returns the same Session for an identical submission retry and rejects changed payloads", async () => {
    const appState = await makeApp();
    const timestamp = createTimestampMs(Date.now());
    const workspace = {
      id: createWorkspaceId(),
      canonicalPath: "C:/session-submission-fixture",
      displayName: "session-submission-fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    };
    await storage!.workspaces.insert(workspace);
    const service = new SessionService({
      repository: storage!.sessions,
      submissions: storage!.submissions,
      workspaceService: new WorkspaceService({ repository: storage!.workspaces }),
    });
    const submissionId = "ce879e7f-a5dc-46bf-b0bc-9ae8bc67f091";
    const input = { workspaceId: workspace.id, title: "First message", submissionId };

    const first = await service.createSession(input);
    const retry = await service.createSession(input);
    expect(retry.id).toBe(first.id);
    await expect(
      service.createSession({ ...input, title: "Different payload" }),
    ).rejects.toMatchObject({ name: "StorageConflictError" });
    await expect(storage?.sessions.list()).resolves.toHaveLength(1);
    await appState.close();
  });
});
