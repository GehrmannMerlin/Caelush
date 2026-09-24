import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type { AgentEvent, RunId, SessionId } from "@caelush/protocol";
import type { DurableAgentEvent } from "../src/index.js";
import type { DurableRunEventReaderPort } from "@caelush/agent";
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
  } as unknown as DurableAgentEvent;
}

class PausedReplayStore implements DurableRunEventReaderPort {
  readonly persisted: DurableAgentEvent[] = [];
  replayStarted!: () => void;
  private resolveReplay!: (events: DurableAgentEvent[]) => void;
  readonly replayPromise = new Promise<DurableAgentEvent[]>((resolve) => {
    this.resolveReplay = resolve;
  });

  async replay(runId: RunId): Promise<DurableAgentEvent[]> {
    this.replayStarted();
    return (await this.replayPromise).filter((event) => event.runId === runId);
  }

  async latestSequence(): Promise<number> {
    return this.persisted.at(-1)?.durability.sequence ?? 0;
  }

  releaseReplay(events: DurableAgentEvent[]): void {
    this.resolveReplay(events);
  }
}

describe("replay/live race", () => {
  it("does not lose or duplicate a durable event published during replay", async () => {
    const store = new PausedReplayStore();
    const bus = new EventBus(store);
    const runId = createRunId();
    const sessionId = createSessionId();
    const old = makeEvent(runId, sessionId, 1);
    store.persisted.push(old);
    store.replayStarted = () => undefined;
    const iterator = bus.watch(runId)[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    const newEvent = makeEvent(runId, sessionId, 2);
    bus.notifyCommitted([newEvent]);
    store.releaseReplay([old, newEvent]);

    const received: AgentEvent[] = [];
    received.push((await first).value as AgentEvent);
    received.push((await iterator.next()).value as AgentEvent);
    expect(
      received.map((event) =>
        event.durability.kind === "DURABLE" ? event.durability.sequence : 0,
      ),
    ).toEqual([1, 2]);
    await iterator.return?.();
  });
});
