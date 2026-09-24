import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
  type DurableRunEvent,
  type RunId,
  type TransientRunEvent,
} from "@caelush/protocol";
import type { DurableRunEventReaderPort } from "@caelush/agent";
import { describe, expect, it } from "vitest";
import {
  EventCursorAheadError,
  RunEventHub,
  encodedRunEventBytes,
  type ObserverErrorSink,
  type RunEventSubscriptionCloseReason,
} from "../src/events/run-event-hub.js";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeDurable(runId: RunId, sequence: number): DurableRunEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId: createSessionId(),
    timestamp: createTimestampMs(sequence),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    type: "shell.output",
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: String(sequence) },
  } as DurableRunEvent;
}

function makeTransient(
  runId: RunId,
  streamKey: string,
  streamSequence: number,
  chunk = String(streamSequence),
  deliveryClass: "ORDERED" | "COALESCIBLE" = "ORDERED",
): TransientRunEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId: createSessionId(),
    timestamp: createTimestampMs(streamSequence),
    visibility: "USER_VISIBLE",
    durability:
      deliveryClass === "ORDERED"
        ? { kind: "EPHEMERAL", version: 1, deliveryClass, streamKey, streamSequence }
        : { kind: "EPHEMERAL", version: 1, deliveryClass, streamKey },
    type: "shell.output",
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk },
  } as TransientRunEvent;
}

class MemoryReader implements DurableRunEventReaderPort {
  readonly events: DurableRunEvent[] = [];
  latestValue = 0;
  latestCalled = deferred<void>();
  replayCalled = deferred<void>();
  replayGate: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;

  async replay(
    runId: RunId,
    options: { afterSequence: number; throughSequence: number; limit: number },
  ): Promise<readonly DurableRunEvent[]> {
    this.replayCalled.resolve();
    await this.replayGate?.promise;
    return this.events
      .filter(
        (event) =>
          event.runId === runId &&
          event.durability.sequence > options.afterSequence &&
          event.durability.sequence <= options.throughSequence,
      )
      .slice(0, options.limit);
  }

  async latestSequence(): Promise<number> {
    this.latestCalled.resolve();
    return this.latestValue;
  }
}

function policy(
  overrides: { readonly maxPendingItems?: number; readonly maxPendingBytes?: number } = {},
) {
  return {
    maxPendingItems: overrides.maxPendingItems ?? 32,
    maxPendingBytes: overrides.maxPendingBytes ?? 64 * 1024,
    durableOverflow: "CLOSE_SUBSCRIPTION" as const,
    orderedTransientOverflow: "CLOSE_SUBSCRIPTION" as const,
    coalescibleTransientOverflow: "REPLACE_BY_STREAM_KEY" as const,
  };
}

describe("RunEventHub", () => {
  it("returns before an unresolved observer and delivers on an independent worker", async () => {
    const reader = new MemoryReader();
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const runId = createRunId();
    const started = deferred<void>();
    const release = deferred<void>();
    let observerStarted = false;
    const subscription = hub.subscribe({ runId }, async () => {
      observerStarted = true;
      started.resolve();
      await release.promise;
    });

    hub.notifyCommitted([makeDurable(runId, 1)]);
    expect(observerStarted).toBe(false);
    await started.promise;
    release.resolve();
    subscription.close();
    await hub.dispose();
  });

  it("isolates sync throws and async rejections while continuing the same subscription", async () => {
    const reader = new MemoryReader();
    const reports: Array<{ subscriptionId: string; eventId: string; eventType: string }> = [];
    const errorSink: ObserverErrorSink = {
      report(input) {
        reports.push({
          subscriptionId: input.subscriptionId,
          eventId: input.eventId,
          eventType: input.eventType,
        });
      },
    };
    const hub = new RunEventHub(reader, { queuePolicy: policy(), errorSink });
    const runId = createRunId();
    const third = deferred<void>();
    let calls = 0;
    const subscription = hub.subscribe({ runId }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("sync observer failure");
      if (calls === 2) throw new Error("async observer failure");
      third.resolve();
    });

    hub.notifyCommitted([makeDurable(runId, 1), makeDurable(runId, 2), makeDurable(runId, 3)]);
    await third.promise;
    expect(calls).toBe(3);
    expect(reports).toHaveLength(2);
    expect(subscription.closed).toBe(false);
    subscription.close();
    await hub.dispose();
  });

  it("keeps a blocked subscriber from blocking another subscriber", async () => {
    const reader = new MemoryReader();
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const runId = createRunId();
    const blocked = deferred<void>();
    const otherReceived = deferred<void>();
    const first = hub.subscribe({ runId }, async () => {
      await blocked.promise;
    });
    const second = hub.subscribe({ runId }, () => otherReceived.resolve());

    hub.notifyCommitted([makeDurable(runId, 1)]);
    await otherReceived.promise;
    expect(first.closed).toBe(false);
    blocked.resolve();
    first.close();
    second.close();
    await hub.dispose();
  });

  it("closes a slow subscriber on durable item overflow", async () => {
    const reader = new MemoryReader();
    const closed: RunEventSubscriptionCloseReason[] = [];
    const hub = new RunEventHub(reader, {
      queuePolicy: policy({ maxPendingItems: 1 }),
      onSubscriptionClosed: (_id, reason) => closed.push(reason),
    });
    const runId = createRunId();
    const release = deferred<void>();
    const started = deferred<void>();
    const subscription = hub.subscribe({ runId }, async () => {
      started.resolve();
      await release.promise;
    });

    hub.notifyCommitted([makeDurable(runId, 1)]);
    await started.promise;
    hub.notifyCommitted([makeDurable(runId, 2), makeDurable(runId, 3)]);
    expect(subscription.closed).toBe(true);
    expect(closed).toContain("SLOW_CONSUMER");
    release.resolve();
    await hub.dispose();
  });

  it("enforces the byte bound independently of the item bound", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    const first = makeDurable(runId, 1);
    const hub = new RunEventHub(reader, {
      queuePolicy: policy({
        maxPendingItems: 10,
        maxPendingBytes: encodedRunEventBytes(first) + 1,
      }),
    });
    const release = deferred<void>();
    const started = deferred<void>();
    const subscription = hub.subscribe({ runId }, async () => {
      started.resolve();
      await release.promise;
    });

    hub.notifyCommitted([first]);
    await started.promise;
    hub.notifyCommitted([makeDurable(runId, 2), makeDurable(runId, 3)]);
    expect(subscription.closed).toBe(true);
    release.resolve();
    await hub.dispose();
  });

  it("coalesces same-stream transient progress with latest-wins semantics", async () => {
    const reader = new MemoryReader();
    const hub = new RunEventHub(reader, { queuePolicy: policy({ maxPendingItems: 2 }) });
    const runId = createRunId();
    const release = deferred<void>();
    const started = deferred<void>();
    const received: TransientRunEvent[] = [];
    const second = deferred<void>();
    const subscription = hub.subscribe({ runId }, async (event) => {
      received.push(event as TransientRunEvent);
      if (received.length === 1) {
        started.resolve();
        await release.promise;
      } else {
        second.resolve();
      }
    });

    hub.emitTransient(makeTransient(runId, "progress", 1, "one", "COALESCIBLE"));
    await started.promise;
    hub.emitTransient(makeTransient(runId, "progress", 2, "two", "COALESCIBLE"));
    hub.emitTransient(makeTransient(runId, "progress", 3, "three", "COALESCIBLE"));
    release.resolve();
    await second.promise;
    expect(received.map((event) => event.payload.chunk)).toEqual(["one", "three"]);
    subscription.close();
    await hub.dispose();
  });

  it("does not coalesce different stream keys and preserves ordered transients", async () => {
    const reader = new MemoryReader();
    const hub = new RunEventHub(reader, { queuePolicy: policy({ maxPendingItems: 3 }) });
    const runId = createRunId();
    const release = deferred<void>();
    const started = deferred<void>();
    const received: TransientRunEvent[] = [];
    const done = deferred<void>();
    const subscription = hub.subscribe({ runId }, async (event) => {
      received.push(event as TransientRunEvent);
      if (received.length === 1) {
        started.resolve();
        await release.promise;
      } else if (received.length === 3) {
        done.resolve();
      }
    });

    hub.emitTransient(makeTransient(runId, "ordered", 1));
    await started.promise;
    hub.emitTransient(makeTransient(runId, "ordered", 2));
    hub.emitTransient(makeTransient(runId, "ordered", 3));
    release.resolve();
    await done.promise;
    expect(received.map((event) => event.durability.streamSequence)).toEqual([1, 2, 3]);
    subscription.close();
    await hub.dispose();
  });

  it("applies run, durability and visibility filters without public projection", async () => {
    const reader = new MemoryReader();
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const runId = createRunId();
    const received: TransientRunEvent[] = [];
    const delivered = deferred<void>();
    const subscription = hub.subscribe(
      { runId, includeDurable: false, includeTransient: true, visibility: ["USER_VISIBLE"] },
      (event) => {
        received.push(event as TransientRunEvent);
        delivered.resolve();
      },
    );

    hub.notifyCommitted([makeDurable(runId, 1)]);
    hub.emitTransient(makeTransient(runId, "visible", 1));
    const debug = { ...makeTransient(runId, "debug", 1), visibility: "DEBUG" as const };
    hub.emitTransient(debug);
    await delivered.promise;
    expect(received).toHaveLength(1);
    expect(received[0]?.durability).toMatchObject({ streamKey: "visible" });
    subscription.close();
    await hub.dispose();
  });

  it("replays to a fixed high watermark and then delivers live events", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    const first = makeDurable(runId, 1);
    const second = makeDurable(runId, 2);
    reader.events.push(first, second);
    reader.latestValue = 2;
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const iterator = hub.watch(runId)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual(first);
    expect((await iterator.next()).value).toEqual(second);
    const third = makeDurable(runId, 3);
    hub.notifyCommitted([third]);
    expect((await iterator.next()).value).toEqual(third);
    await iterator.return?.();
    await hub.dispose();
  });

  it("bridges a durable commit during replay exactly once and discards catch-up transient output", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    const first = makeDurable(runId, 1);
    reader.events.push(first);
    reader.latestValue = 1;
    const replayGate = deferred<void>();
    reader.replayGate = replayGate;
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const iterator = hub.watch(runId)[Symbol.asyncIterator]();
    const firstNext = iterator.next();
    await reader.latestCalled.promise;

    const second = makeDurable(runId, 2);
    const staleTransient = makeTransient(runId, "progress", 1);
    hub.notifyCommitted([second]);
    hub.emitTransient(staleTransient);
    replayGate.resolve();

    expect((await firstNext).value).toEqual(first);
    expect((await iterator.next()).value).toEqual(second);
    const liveTransient = makeTransient(runId, "progress", 2);
    hub.emitTransient(liveTransient);
    expect((await iterator.next()).value).toEqual(liveTransient);
    await iterator.return?.();
    await hub.dispose();
  });

  it("rejects a cursor ahead of the high watermark without waiting", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    reader.latestValue = 2;
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const iterator = hub.watch(runId, { afterSequence: 3 })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(EventCursorAheadError);
    await hub.dispose();
  });

  it("aborts a replay that is paused in the reader and closes the live subscription", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    reader.latestValue = 1;
    const replayGate = deferred<void>();
    reader.replayGate = replayGate;
    const closed: RunEventSubscriptionCloseReason[] = [];
    const hub = new RunEventHub(reader, {
      queuePolicy: policy(),
      onSubscriptionClosed: (_id, reason) => closed.push(reason),
    });
    const controller = new AbortController();
    const iterator = hub.watch(runId, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await reader.latestCalled.promise;
    await reader.replayCalled.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toContain("ABORTED");
    replayGate.resolve();
    await hub.dispose();
  });

  it("closes immediately as aborted when the watch signal is already aborted", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    const controller = new AbortController();
    controller.abort();
    const closed: RunEventSubscriptionCloseReason[] = [];
    const hub = new RunEventHub(reader, {
      queuePolicy: policy(),
      onSubscriptionClosed: (_id, reason) => closed.push(reason),
    });
    const iterator = hub.watch(runId, { signal: controller.signal })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(closed).toContain("ABORTED");
    await hub.dispose();
  });

  it("bounds an unread watch stream instead of allowing its live queue to grow", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    reader.latestValue = 0;
    const closed: RunEventSubscriptionCloseReason[] = [];
    const hub = new RunEventHub(reader, {
      queuePolicy: policy({ maxPendingItems: 1 }),
      onSubscriptionClosed: (_id, reason) => closed.push(reason),
    });
    const iterator = hub.watch(runId)[Symbol.asyncIterator]();
    const first = iterator.next();
    await reader.latestCalled.promise;
    hub.notifyCommitted([makeDurable(runId, 1), makeDurable(runId, 2), makeDurable(runId, 3)]);

    expect(await first).toMatchObject({ done: true });
    expect(closed).toContain("SLOW_CONSUMER");
    await iterator.return?.();
    await hub.dispose();
  });

  it("fails closed when the reader violates strict sequence ordering", async () => {
    const reader = new MemoryReader();
    const runId = createRunId();
    reader.events.push(makeDurable(runId, 1), makeDurable(runId, 3), makeDurable(runId, 2));
    reader.latestValue = 3;
    const hub = new RunEventHub(reader, { queuePolicy: policy() });
    const iterator = hub.watch(runId)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/strictly increasing/);
    await hub.dispose();
  });

  it("closes a watch subscription when its iterator returns and disposes all subscriptions", async () => {
    const reader = new MemoryReader();
    const closed: RunEventSubscriptionCloseReason[] = [];
    const hub = new RunEventHub(reader, {
      queuePolicy: policy(),
      onSubscriptionClosed: (_id, reason) => closed.push(reason),
    });
    const runId = createRunId();
    const iterator = hub.watch(runId)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await reader.latestCalled.promise;
    await iterator.return?.();
    await pending;
    const subscription = hub.subscribe({ runId }, () => undefined);
    await hub.dispose();
    expect(subscription.closed).toBe(true);
    expect(closed).toContain("UNSUBSCRIBED");
    expect(closed).toContain("HUB_DISPOSED");
    expect(() => hub.subscribe({ runId }, () => undefined)).toThrow(/disposed/);
    expect(() => hub.watch(runId)).toThrow(/disposed/);
  });
});
