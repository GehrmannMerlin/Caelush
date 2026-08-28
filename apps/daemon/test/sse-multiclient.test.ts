import {
  AgentEventSchema,
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventDraft, DurableEventStore } from "@caelush/events";
import { EventBus } from "@caelush/events";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

class MemoryEventStore implements DurableEventStore {
  private readonly events: DurableAgentEvent[] = [];

  async append(draft: DurableEventDraft): Promise<DurableAgentEvent> {
    const sequence = this.events.filter((event) => event.runId === draft.runId).length + 1;
    const event = AgentEventSchema.parse({
      ...draft,
      durability: { ...draft.durability, sequence },
    }) as DurableAgentEvent;
    this.events.push(event);
    return event;
  }

  async replay(runId: DurableAgentEvent["runId"], options: { afterSequence?: number } = {}) {
    return this.events.filter(
      (event) => event.runId === runId && event.durability.sequence > (options.afterSequence ?? 0),
    );
  }

  async latestSequence(runId: DurableAgentEvent["runId"]): Promise<number> {
    return this.events.filter((event) => event.runId === runId).at(-1)?.durability.sequence ?? 0;
  }
}

let app: ReturnType<typeof buildDaemonApp> | undefined;
let activeStreams: Set<AbortController> | undefined;

afterEach(async () => {
  for (const controller of activeStreams ?? []) controller.abort();
  await app?.close();
  app = undefined;
  activeStreams = undefined;
});

function makeEvent(runId: string, sessionId: string, kind: "DURABLE" | "EPHEMERAL") {
  return {
    eventId: createEventId(),
    schemaVersion: 1 as const,
    runId,
    sessionId,
    type: "shell.output" as const,
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE" as const,
    durability:
      kind === "DURABLE"
        ? ({ kind: "DURABLE", version: 1 } as const)
        : ({ kind: "EPHEMERAL" } as const),
    payload: { invocationId: createToolInvocationId(), stream: "stdout" as const, chunk: kind },
  };
}

describe("multi-client SSE", () => {
  it("fans out Durable and Ephemeral events to two clients", async () => {
    const sessionId = createSessionId();
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: "multi-client",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "C:/workspace" },
      model: { provider: "test", model: "test-model" },
      runtime: { id: "local", kind: "test" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
      createdAt: 1_700_000_000_000,
    });
    const eventBus = new EventBus(new MemoryEventStore());
    activeStreams = new Set();
    app = buildDaemonApp({
      sessions: {} as never,
      runs: { get: async () => run } as never,
      eventBus,
      activeStreams,
      config: { host: "127.0.0.1", port: 0, sseHeartbeatIntervalMs: 0 },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/api/v1/runs/${run.id}/events`;

    const responseA = fetch(url, { headers: { accept: "text/event-stream" } });
    const responseB = fetch(url, { headers: { accept: "text/event-stream" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eventBus.publish(makeEvent(run.id, sessionId, "DURABLE") as never);
    const [streamA, streamB] = await Promise.all([responseA, responseB]);
    const readerA = streamA.body?.getReader();
    const readerB = streamB.body?.getReader();
    if (!readerA || !readerB) throw new Error("SSE responses have no body");
    const [firstA, firstB] = await Promise.all([readerA.read(), readerB.read()]);
    expect(new TextDecoder().decode(firstA.value)).toContain("id: 1");
    expect(new TextDecoder().decode(firstB.value)).toContain("id: 1");

    const nextA = readerA.read();
    const nextB = readerB.read();
    await eventBus.publish(makeEvent(run.id, sessionId, "EPHEMERAL") as never);
    const [ephemeralA, ephemeralB] = await Promise.all([nextA, nextB]);
    const frameA = new TextDecoder().decode(ephemeralA.value);
    const frameB = new TextDecoder().decode(ephemeralB.value);
    expect(frameA).toContain("event: shell.output");
    expect(frameB).toContain("data:");
    expect(frameA).not.toContain("id:");
    expect(frameB).not.toContain("id:");
    await Promise.all([readerA.cancel(), readerB.cancel()]);
  });
});
