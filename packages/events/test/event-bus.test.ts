import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type { AgentEvent, RunId, SessionId } from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventDraft, DurableEventStore } from "../src/index.js";
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

function makeEphemeral(runId: RunId, sessionId: SessionId): AgentEvent {
  return {
    ...makeDraft(runId, sessionId),
    durability: { kind: "EPHEMERAL" },
  };
}

class InMemoryStore implements DurableEventStore {
  readonly appended: DurableEventDraft[] = [];
  nextSequence = 0;
  appendImplementation?: (event: DurableEventDraft) => Promise<DurableAgentEvent>;

  async append(event: DurableEventDraft): Promise<DurableAgentEvent> {
    this.appended.push(event);
    if (this.appendImplementation) return this.appendImplementation(event);
    this.nextSequence += 1;
    return { ...event, durability: { ...event.durability, sequence: this.nextSequence } };
  }

  async replay(): Promise<DurableAgentEvent[]> {
    return [];
  }

  async latestSequence(): Promise<number> {
    return this.nextSequence;
  }
}

describe("EventBus", () => {
  it("persists durable events before notifying subscribers", async () => {
    const store = new InMemoryStore();
    let resolveAppend!: (event: DurableAgentEvent) => void;
    store.appendImplementation = () =>
      new Promise((resolve) => {
        resolveAppend = resolve;
      });
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    const received: AgentEvent[] = [];
    bus.subscribe(runId, (event) => received.push(event));
    const publish = bus.publish(makeDraft(runId, sessionId));

    await Promise.resolve();
    expect(received).toHaveLength(0);
    resolveAppend({
      ...makeDraft(runId, sessionId),
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
    });
    await publish;
    expect(received).toHaveLength(1);
    expect(received[0]?.durability).toMatchObject({ kind: "DURABLE", sequence: 1 });
  });

  it("does not notify subscribers when durable persistence fails", async () => {
    const store = new InMemoryStore();
    store.appendImplementation = async () => {
      throw new Error("disk full");
    };
    const bus = new EventBus(store);
    const runId = createRunId();
    const received: AgentEvent[] = [];
    bus.subscribe(runId, () => received.push(makeEphemeral(runId, createSessionId())));

    await expect(bus.publish(makeDraft(runId))).rejects.toThrow("disk full");
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
    expect(store.appended).toHaveLength(0);
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
