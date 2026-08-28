import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";

const handles: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => undefined);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function makeDatabasePath(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `caelush-${name}-`));
  directories.push(directory);
  return join(directory, "caelush.db");
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

describe("daemon lifecycle", () => {
  it("starts on an ephemeral port and closes idempotently with active SSE", async () => {
    const databasePath = await makeDatabasePath("shutdown");
    const handle = await startDaemon({ databasePath, port: 0, sseHeartbeatIntervalMs: 0 });
    handles.push(handle);
    const health = await fetch(`${handle.url}/api/v1/health`);
    expect(health.status).toBe(200);

    const { body: session } = await jsonRequest(`${handle.url}/api/v1/sessions`, { method: "POST", body: "{}" });
    const { body: run } = await jsonRequest(`${handle.url}/api/v1/sessions/${session.id}/runs`, {
      method: "POST",
      body: JSON.stringify({
        goal: "shutdown",
        workspace: { id: "wsp_00000000-0000-7000-8000-000000000000", path: "C:/workspace" },
        model: { provider: "test", model: "test-model" },
        runtime: { id: "local", kind: "test" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
        limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
      }),
    });
    const stream = fetch(`${handle.url}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await Promise.race([
      handle.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("daemon close timeout")), 2000)),
    ]);
    await expect(handle.close()).resolves.toBeUndefined();
    const streamResponse = await stream;
    const reader = streamResponse.body?.getReader();
    if (reader) await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("rejects an invalid database startup before listening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-invalid-db-"));
    directories.push(directory);
    await expect(startDaemon({ databasePath: directory, port: 0 })).rejects.toThrow();
  });

  it("fails clearly when the requested port is already occupied", async () => {
    const first = await startDaemon({ databasePath: await makeDatabasePath("first"), port: 0 });
    handles.push(first);
    const port = new URL(first.url).port;
    await expect(
      startDaemon({ databasePath: await makeDatabasePath("second"), port: Number(port) }),
    ).rejects.toThrow();
  });
});
