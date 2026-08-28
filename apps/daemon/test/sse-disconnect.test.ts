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

class Store implements DurableEventStore {
  private readonly events: DurableAgentEvent[] = [];

  async append(draft: DurableEventDraft): Promise<DurableAgentEvent> {
    const event = AgentEventSchema.parse({
      ...draft,
      durability: { ...draft.durability, sequence: this.events.length + 1 },
    }) as DurableAgentEvent;
    this.events.push(event);
    return event;
  }

  async replay(runId: DurableAgentEvent["runId"]) {
    return this.events.filter((event) => event.runId === runId);
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
});

function makeEvent(runId: string, sessionId: string) {
  return {
    eventId: createEventId(),
    schemaVersion: 1 as const,
    runId,
    sessionId,
    type: "shell.output" as const,
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 },
    payload: { invocationId: createToolInvocationId(), stream: "stdout" as const, chunk: "first" },
  };
}

describe("SSE disconnect cleanup", () => {
  it("terminates the watch after the client closes and ignores later events", async () => {
    const sessionId = createSessionId();
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: "disconnect",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "C:/workspace" },
      model: { provider: "test", model: "test-model" },
      runtime: { id: "local", kind: "test" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
      createdAt: 1_700_000_000_000,
    });
    const eventBus = new EventBus(new Store());
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

    const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eventBus.publish(makeEvent(run.id, sessionId) as never);
    const response = await responsePromise;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    await reader.read();
    await reader.cancel();

    for (let attempt = 0; attempt < 20 && activeStreams.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(activeStreams).toHaveLength(0);
    await eventBus.publish(makeEvent(run.id, sessionId) as never);
  });
});
