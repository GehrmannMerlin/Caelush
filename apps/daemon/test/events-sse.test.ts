import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEventSchema,
  AgentRunSchema,
  AgentSessionSchema,
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { EventBus } from "@caelush/events";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

let app: ReturnType<typeof buildDaemonApp> | undefined;
let storage: CaelushStorage | undefined;
let directory: string | undefined;
let activeStreams: Set<AbortController> | undefined;

afterEach(async () => {
  for (const controller of activeStreams ?? []) controller.abort();
  await app?.close();
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  app = undefined;
  storage = undefined;
  directory = undefined;
  activeStreams = undefined;
});

async function makeServer() {
  directory = await mkdtemp(join(tmpdir(), "caelush-events-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const eventBus = new EventBus(storage.events);
  activeStreams = new Set();
  const session = AgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    metadata: {},
  });
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: session.id,
    goal: "stream events",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: 1_700_000_000_000,
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventBus,
    activeStreams,
    config: { host: "127.0.0.1", port: 0, sseHeartbeatIntervalMs: 0 },
  });
  return { app, eventBus, run };
}

function eventDraft(run: { id: string; sessionId: string }) {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    type: "shell.output" as const,
    timestamp: 1_700_000_000_001,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 },
    payload: { invocationId: createToolInvocationId(), stream: "stdout" as const, chunk: "hello" },
  };
}

describe("event stream route", () => {
  it("returns JSON 404 before committing SSE headers for a missing Run", async () => {
    const { app: server } = await makeServer();
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/runs/run_00000000-0000-7000-8000-000000000000/events",
      headers: { host: "127.0.0.1", accept: "text/event-stream" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("streams a Durable event over a real HTTP socket", async () => {
    const { app: server, eventBus, run } = await makeServer();
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");

    const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eventBus.publish(eventDraft(run));
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), 1000)),
    ]);
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: shell.output");
    expect(text).toContain("id: 1");
    expect(text).toContain('"chunk":"hello"');
    await reader.cancel();
  });
});
