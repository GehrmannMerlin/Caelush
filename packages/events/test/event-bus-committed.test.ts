import { describe, expect, it } from "vitest";
import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventStore } from "../src/index.js";
import { EventBus } from "../src/event-bus.js";

function event(): DurableAgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId: createRunId(),
    sessionId: createSessionId(),
    timestamp: createTimestampMs(10),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    type: "shell.output",
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "ready" },
  };
}

class Store implements DurableEventStore {
  appendCount = 0;
  async append(): Promise<never> {
    this.appendCount += 1;
    throw new Error("notifyCommitted must not append");
  }
  async replay(): Promise<DurableAgentEvent[]> {
    return [];
  }
  async latestSequence(): Promise<number> {
    return 1;
  }
}

describe("EventBus committed notification", () => {
  it("notifies already-committed events without persisting them again", () => {
    const store = new Store();
    const bus = new EventBus(store);
    const committed = event();
    const received: DurableAgentEvent[] = [];
    bus.subscribe(committed.runId, (value) => received.push(value as DurableAgentEvent));

    bus.notifyCommitted([committed]);

    expect(received).toEqual([committed]);
    expect(store.appendCount).toBe(0);
  });
});
