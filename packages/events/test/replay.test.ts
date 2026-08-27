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

function makeEvent(runId: RunId, sessionId: SessionId, sequence: number): DurableAgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(sequence),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    type: "shell.output",
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: `${sequence}` },
  };
}

class ReplayStore implements DurableEventStore {
  readonly events: DurableAgentEvent[] = [];
  replayStarted?: () => void;
  replayImplementation?: () => Promise<DurableAgentEvent[]>;

  async append(event: DurableEventDraft): Promise<DurableAgentEvent> {
    const persisted = makeEvent(event.runId, event.sessionId, this.events.length + 1);
    this.events.push(persisted);
    return persisted;
  }

  async replay(
    runId: RunId,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<DurableAgentEvent[]> {
    this.replayStarted?.();
    if (this.replayImplementation) return this.replayImplementation();
    return this.events
      .filter(
        (event) =>
          event.runId === runId && event.durability.sequence > (options.afterSequence ?? 0),
      )
      .slice(0, options.limit ?? 100);
  }

  async latestSequence(runId: RunId): Promise<number> {
    return this.events.filter((event) => event.runId === runId).at(-1)?.durability.sequence ?? 0;
  }
}

describe("EventBus replay and live tail", () => {
  it("replays after an exclusive cursor and then yields live events", async () => {
    const store = new ReplayStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    store.events.push(makeEvent(runId, sessionId, 1), makeEvent(runId, sessionId, 2));
    const iterator = bus.watch(runId, { afterSequence: 1 })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ durability: { sequence: 2 } });
    await bus.publish({
      ...makeEvent(runId, sessionId, 3),
      durability: { kind: "EPHEMERAL" },
    });
    const live = iterator.next();
    await expect(live).resolves.toMatchObject({ value: { durability: { kind: "EPHEMERAL" } } });
    await iterator.return?.();
  });

  it("paginates bounded replay history before entering the live tail", async () => {
    const store = new ReplayStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    store.events.push(
      ...Array.from({ length: 1001 }, (_, index) => makeEvent(runId, sessionId, index + 1)),
    );
    const iterator = bus.watch(runId)[Symbol.asyncIterator]();
    const received: AgentEvent[] = [];

    for (let index = 0; index < 1001; index += 1) {
      received.push((await iterator.next()).value as AgentEvent);
    }

    expect(received).toHaveLength(1001);
    expect(received[0]).toMatchObject({ durability: { sequence: 1 } });
    expect(received.at(-1)).toMatchObject({ durability: { sequence: 1001 } });
    await iterator.return?.();
  });
});
