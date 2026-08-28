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
import { buildDaemonApp, startDaemon } from "../src/index.js";
import { nextSseFrame, sseFrameId } from "./support/sse-client.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;
let handle: { close(): Promise<void> } | undefined;
let activeStreams: Set<AbortController> | undefined;

afterEach(async () => {
  for (const controller of activeStreams ?? []) controller.abort();
  await app?.close().catch(() => undefined);
  await handle?.close().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  app = undefined;
  handle = undefined;
  activeStreams = undefined;
});

function durableDraft(runId: string, sessionId: string, chunk: string) {
  return {
    eventId: createEventId(),
    schemaVersion: 1 as const,
    runId,
    sessionId,
    type: "shell.output" as const,
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 },
    payload: { invocationId: createToolInvocationId(), stream: "stdout" as const, chunk },
  };
}

function ephemeralEvent(runId: string, sessionId: string) {
  return AgentEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    type: "shell.output",
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability: { kind: "EPHEMERAL" },
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "ephemeral" },
  });
}

async function startFactory(databasePath: string) {
  storage = await openCaelushStorage({ path: databasePath });
  const eventBus = new EventBus(storage.events);
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
  return { eventBus, url: `http://127.0.0.1:${address.port}` };
}

describe("Caelush local service E2E", () => {
  it("closes, reconnects, and recovers durable state across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-e2e-"));
    const databasePath = join(directory, "caelush.db");
    const { eventBus, url } = await startFactory(databasePath);

    const sessionResponse = await fetch(`${url}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const runResponse = await fetch(`${url}/api/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "full e2e",
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        model: { provider: "test", model: "test-model" },
        runtime: { id: "local", kind: "test" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
        limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
      }),
    });
    expect(runResponse.status).toBe(201);
    const run = (await runResponse.json()) as { id: string; status: string };
    expect(run.status).toBe("PENDING");

    const streamUrl = `${url}/api/v1/runs/${run.id}/events`;
    const responseA = fetch(streamUrl, { headers: { accept: "text/event-stream" } });
    const responseB = fetch(streamUrl, { headers: { accept: "text/event-stream" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eventBus.publish(durableDraft(run.id, session.id, "1"));
    const [sseA, sseB] = await Promise.all([responseA, responseB]);
    const readerA = sseA.body?.getReader();
    const readerB = sseB.body?.getReader();
    if (!readerA || !readerB) throw new Error("SSE body missing");
    const [frameA1, frameB1] = await Promise.all([nextSseFrame(readerA), nextSseFrame(readerB)]);
    expect(sseFrameId(frameA1.frame)).toBe("1");
    expect(sseFrameId(frameB1.frame)).toBe("1");
    await readerA.cancel();

    await eventBus.publish(durableDraft(run.id, session.id, "2"));
    await eventBus.publish(durableDraft(run.id, session.id, "3"));
    const bReplay2 = await nextSseFrame(readerB);
    const bReplay3 = await nextSseFrame(readerB, bReplay2.rest);
    expect([sseFrameId(bReplay2.frame), sseFrameId(bReplay3.frame)]).toEqual(["2", "3"]);
    const reconnectResponse = await fetch(streamUrl, {
      headers: { accept: "text/event-stream", "last-event-id": "1" },
    });
    const reconnectReader = reconnectResponse.body?.getReader();
    if (!reconnectReader) throw new Error("reconnect body missing");
    const replay2 = await nextSseFrame(reconnectReader);
    const replay3 = await nextSseFrame(reconnectReader, replay2.rest);
    expect([sseFrameId(replay2.frame), sseFrameId(replay3.frame)]).toEqual(["2", "3"]);

    const liveA = reconnectReader.read();
    const liveB = readerB.read();
    await eventBus.publish(durableDraft(run.id, session.id, "4"));
    const liveAResult = await liveA;
    const liveBResult = await liveB;
    expect(sseFrameId(new TextDecoder().decode(liveAResult.value))).toBe("4");
    expect(new TextDecoder().decode(liveBResult.value)).toContain('"chunk":"4"');

    const ephemeralA = reconnectReader.read();
    const ephemeralB = readerB.read();
    await eventBus.publish(ephemeralEvent(run.id, session.id));
    const ephemeralFrameA = new TextDecoder().decode((await ephemeralA).value);
    const ephemeralFrameB = new TextDecoder().decode((await ephemeralB).value);
    expect(ephemeralFrameA).not.toContain("id:");
    expect(ephemeralFrameB).not.toContain("id:");
    await Promise.all([reconnectReader.cancel(), readerB.cancel()]);

    await app?.close();
    await storage?.close();
    app = undefined;
    storage = undefined;

    handle = await startDaemon({ databasePath, port: 0, sseHeartbeatIntervalMs: 0 });
    const recoveredSession = await fetch(`${handle.url}/api/v1/sessions/${session.id}`);
    const recoveredRun = await fetch(`${handle.url}/api/v1/runs/${run.id}`);
    expect(recoveredSession.status).toBe(200);
    expect(recoveredRun.status).toBe(200);
    expect((await recoveredRun.json()).status).toBe("PENDING");

    const history = await fetch(`${handle.url}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": "0" },
    });
    const historyReader = history.body?.getReader();
    if (!historyReader) throw new Error("history body missing");
    const historyFrame = await nextSseFrame(historyReader);
    expect(sseFrameId(historyFrame.frame)).toBe("1");
    await historyReader.cancel();
  }, 15_000);
});
