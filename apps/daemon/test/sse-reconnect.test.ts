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
  directory = await mkdtemp(join(tmpdir(), "caelush-reconnect-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const eventBus = new EventBus(storage.events);
  const session = AgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    metadata: {},
  });
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: session.id,
    goal: "reconnect",
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
  activeStreams = new Set();
  app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventBus,
    activeStreams,
    config: { host: "127.0.0.1", port: 0, sseHeartbeatIntervalMs: 0 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { eventBus, run, url: `http://127.0.0.1:${address.port}` };
}

function eventDraft(run: { id: string; sessionId: string }, sequence: number) {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    type: "shell.output" as const,
    timestamp: 1_700_000_000_000 + sequence,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 },
    payload: {
      invocationId: createToolInvocationId(),
      stream: "stdout" as const,
      chunk: String(sequence),
    },
  };
}

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial = "",
): Promise<{ frame: string; rest: string }> {
  let text = initial;
  while (!text.includes("\n\n")) {
    const result = await reader.read();
    if (result.done) throw new Error("SSE stream ended before a frame");
    text += new TextDecoder().decode(result.value);
  }
  const [frame, ...rest] = text.split("\n\n");
  return { frame, rest: rest.join("\n\n") };
}

function frameId(frame: string): string | undefined {
  return frame.match(/^id: (.+)$/m)?.[1];
}

describe("SSE reconnect", () => {
  it("replays after Last-Event-ID without gaps or duplicates, then tails live", async () => {
    const { eventBus, run, url } = await makeServer();
    await eventBus.publish(eventDraft(run, 1));
    await eventBus.publish(eventDraft(run, 2));
    await eventBus.publish(eventDraft(run, 3));

    const response = await fetch(`${url}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": "1" },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");

    let buffer = "";
    const first = await nextFrame(reader, buffer);
    buffer = first.rest;
    const second = await nextFrame(reader, buffer);
    buffer = second.rest;
    expect([frameId(first.frame), frameId(second.frame)]).toEqual(["2", "3"]);

    const liveFrame = reader.read();
    await eventBus.publish(eventDraft(run, 4));
    const live = await Promise.race([
      liveFrame,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live SSE timeout")), 1000)),
    ]);
    expect(new TextDecoder().decode(live.value)).toContain("id: 4");
    await reader.cancel();
  });
});
