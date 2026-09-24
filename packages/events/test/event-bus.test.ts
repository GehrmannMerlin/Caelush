import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type {
  AgentEvent,
  RunId,
  SessionId,
  TransientRunEvent,
} from "@caelush/protocol";
import type { DurableRunEventReaderPort } from "@caelush/agent";
import type { DurableEventDraft } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.js";

function makeDraft(
  runId: RunId = createRunId(),
  sessionId: SessionId = createSessionId(),
): DurableEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(1),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "shell.output",
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "data" },
  };
}

function makeEphemeral(runId: RunId, sessionId: SessionId): TransientRunEvent {
  return {
    ...makeDraft(runId, sessionId),
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey: "test",
      streamSequence: 1,
    },
  } as TransientRunEvent;
}

class InMemoryStore implements DurableRunEventReaderPort {
  async replay(): Promise<never[]> {
    return [];
  }

  async latestSequence(): Promise<number> { return 0; }
}

describe("EventBus", () => {
  it("rejects durable events instead of persisting or notifying them", async () => {
    const store = new InMemoryStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const received: AgentEvent[] = [];
    bus.subscribe(runId, (event) => received.push(event));
    await expect(bus.publish(makeDraft(runId) as never)).rejects.toThrow(/cannot persist durable/i);
    expect(received).toHaveLength(0);
  });

  it("fans out ephemeral events without durable append", async () => {
    const store = new InMemoryStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    const received: AgentEvent[] = [];
    bus.subscribe(runId, (event) => received.push(event));

    await bus.publish(makeEphemeral(runId, sessionId));
    expect(received).toHaveLength(1);
  });

  it("isolates subscriber failures and makes unsubscribe idempotent", async () => {
    const store = new InMemoryStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    let received = 0;
    bus.subscribe(runId, () => {
      throw new Error("subscriber failed");
    });
    const unsubscribe = bus.subscribe(runId, () => {
      received += 1;
    });
    unsubscribe();
    unsubscribe();
    bus.subscribe(runId, () => {
      received += 10;
    });

    await bus.publish(makeEphemeral(runId, sessionId));
    expect(received).toBe(10);
  });
});
