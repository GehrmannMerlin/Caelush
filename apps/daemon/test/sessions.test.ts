import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@caelush/events";
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
  directory = await mkdtemp(join(tmpdir(), "caelush-session-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  return buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventBus: new EventBus(storage.events),
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
});
