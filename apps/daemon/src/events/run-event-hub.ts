import { randomUUID } from "node:crypto";
import type {
  DurableRunEvent,
  EventVisibility,
  RunEvent,
  RunId,
  TransientRunEvent,
} from "@caelush/protocol";
import type { DurableRunEventReaderPort, RunEventNotifierPort } from "@caelush/agent";
import {
  BoundedSubscriberQueue,
  DEFAULT_SUBSCRIBER_QUEUE_POLICY,
  type SubscriberQueueCloseReason,
  type SubscriberQueuePolicy,
} from "./subscriber-queue.js";

export { encodedRunEventBytes } from "./subscriber-queue.js";

const REPLAY_PAGE_SIZE = 1000;

export interface RunEventObserver {
  (event: RunEvent, context: RunEventDeliveryContext): void | Promise<void>;
}

export interface RunEventDeliveryContext {
  readonly subscriptionId: string;
  readonly signal: AbortSignal;
}

export interface RunEventSubscriptionFilter {
  readonly runId: RunId;
  readonly includeDurable?: boolean;
  readonly includeTransient?: boolean;
  readonly visibility?: readonly EventVisibility[];
}

export interface RunEventSubscription {
  readonly id: string;
  readonly closed: boolean;
  close(reason?: RunEventSubscriptionCloseReason): void;
}

export type RunEventSubscriptionCloseReason = SubscriberQueueCloseReason;

export interface RunEventWatchOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
}

export type RunEventStream = AsyncIterable<RunEvent>;

export interface ObserverErrorSink {
  report(input: {
    readonly subscriptionId: string;
    readonly runId: RunId;
    readonly eventId: string;
    readonly eventType: string;
    readonly error: unknown;
  }): void;
}

export interface RunEventHubOptions {
  readonly queuePolicy?: SubscriberQueuePolicy;
  readonly errorSink?: ObserverErrorSink;
  readonly onSubscriptionClosed?: (
    subscriptionId: string,
    reason: RunEventSubscriptionCloseReason,
  ) => void;
}

export class EventCursorAheadError extends Error {
  readonly code = "EVENT_CURSOR_AHEAD" as const;

  constructor(
    readonly runId: RunId,
    readonly afterSequence: number,
    readonly highWatermark: number,
  ) {
    super(
      `Event cursor ${afterSequence} is ahead of Run ${runId} high watermark ${highWatermark}.`,
    );
    this.name = "EventCursorAheadError";
  }
}

export class RunEventReplayError extends Error {
  readonly code = "EVENT_REPLAY_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "RunEventReplayError";
  }
}

export class RunEventHubDisposedError extends Error {
  readonly code = "EVENT_HUB_DISPOSED" as const;

  constructor() {
    super("The RunEventHub has been disposed.");
    this.name = "RunEventHubDisposedError";
  }
}

function randomSubscriptionId(): string {
  return `sub_${randomUUID()}`;
}

function isDurable(event: RunEvent): event is DurableRunEvent {
  return event.durability.kind === "DURABLE";
}

function matchesFilter(event: RunEvent, filter: RunEventSubscriptionFilter): boolean {
  if (event.runId !== filter.runId) return false;
  if (isDurable(event)) {
    if (filter.includeDurable === false) return false;
  } else if (filter.includeTransient === false) {
    return false;
  }
  return filter.visibility === undefined || filter.visibility.includes(event.visibility);
}

function sanitizeObserverError(error: unknown): { readonly classification: string } {
  if (error instanceof Error) return { classification: error.name || "Error" };
  return { classification: typeof error };
}

const defaultObserverErrorSink: ObserverErrorSink = {
  report(input) {
    console.error("Caelush RunEvent observer failed.", {
      subscriptionId: input.subscriptionId,
      runId: input.runId,
      eventId: input.eventId,
      eventType: input.eventType,
      error: sanitizeObserverError(input.error),
    });
  },
};

interface SubscriptionState {
  readonly id: string;
  readonly filter: RunEventSubscriptionFilter;
  readonly controller: AbortController;
  readonly queue: BoundedSubscriberQueue;
  readonly observer: RunEventObserver | undefined;
  closed: boolean;
  close(reason: RunEventSubscriptionCloseReason): void;
}

interface WatchControl {
  close: (() => void) | undefined;
}

export class RunEventHub implements RunEventNotifierPort {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly queuePolicy: SubscriberQueuePolicy;
  private readonly errorSink: ObserverErrorSink;
  private readonly onSubscriptionClosed: RunEventHubOptions["onSubscriptionClosed"];
  private disposed = false;

  constructor(
    private readonly reader: DurableRunEventReaderPort,
    options: RunEventHubOptions = {},
  ) {
    this.queuePolicy = options.queuePolicy ?? DEFAULT_SUBSCRIBER_QUEUE_POLICY;
    validateSubscriberQueuePolicy(this.queuePolicy);
    this.errorSink = options.errorSink ?? defaultObserverErrorSink;
    this.onSubscriptionClosed = options.onSubscriptionClosed;
  }

  subscribe(filter: RunEventSubscriptionFilter, observer: RunEventObserver): RunEventSubscription {
    if (this.disposed) throw new RunEventHubDisposedError();
    const state = this.createSubscription(filter, observer);
    this.startObserverWorker(state);
    return this.publicSubscription(state);
  }

  watch(runId: RunId, options: RunEventWatchOptions = {}): RunEventStream {
    if (this.disposed) throw new RunEventHubDisposedError();
    const control: WatchControl = { close: undefined };
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = this.watchEvents(runId, options, control)[Symbol.asyncIterator]();
        return {
          next: (value?: unknown) => iterator.next(value),
          return: async () => {
            control.close?.();
            return (await iterator.return?.()) ?? { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  notifyCommitted(events: readonly DurableRunEvent[]): void {
    for (const event of events) this.enqueue(event);
  }

  emitTransient(event: TransientRunEvent): void {
    this.enqueue(event);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of [...this.subscriptions.values()]) {
      subscription.close("HUB_DISPOSED");
    }
    this.subscriptions.clear();
    await Promise.resolve();
  }

  private createSubscription(
    filter: RunEventSubscriptionFilter,
    observer: RunEventObserver | undefined,
  ): SubscriptionState {
    const id = randomSubscriptionId();
    const stateRef: { current: SubscriptionState | undefined } = { current: undefined };
    const queue = new BoundedSubscriberQueue(this.queuePolicy, () =>
      stateRef.current?.close("SLOW_CONSUMER"),
    );
    const state: SubscriptionState = {
      id,
      filter,
      controller: new AbortController(),
      queue,
      observer,
      closed: false,
      close: (reason) => {
        if (state.closed) return;
        state.closed = true;
        state.controller.abort();
        state.queue.close(reason);
        this.subscriptions.delete(state.id);
        try {
          this.onSubscriptionClosed?.(state.id, reason);
        } catch {
          // Close diagnostics are observational and cannot affect the producer.
        }
      },
    };
    stateRef.current = state;
    this.subscriptions.set(id, state);
    return state;
  }

  private publicSubscription(state: SubscriptionState): RunEventSubscription {
    return {
      id: state.id,
      get closed() {
        return state.closed;
      },
      close: (reason = "UNSUBSCRIBED") => state.close(reason),
    };
  }

  private startObserverWorker(state: SubscriptionState): void {
    if (state.observer === undefined) return;
    queueMicrotask(() => {
      void this.runObserverWorker(state);
    });
  }

  private async runObserverWorker(state: SubscriptionState): Promise<void> {
    while (!state.closed) {
      const event = await state.queue.next();
      if (event === undefined) return;
      try {
        await state.observer?.(event, {
          subscriptionId: state.id,
          signal: state.controller.signal,
        });
      } catch (error) {
        try {
          this.errorSink.report({
            subscriptionId: state.id,
            runId: event.runId,
            eventId: event.eventId,
            eventType: event.type,
            error,
          });
        } catch {
          // Error reporting is observational and must not terminate delivery.
        }
      }
    }
  }

  private enqueue(event: RunEvent): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.closed && matchesFilter(event, subscription.filter)) {
        subscription.queue.enqueue(event);
      }
    }
  }

  private async *watchEvents(
    runId: RunId,
    options: RunEventWatchOptions,
    control: WatchControl,
  ): AsyncIterable<RunEvent> {
    const afterSequence = options.afterSequence ?? 0;
    validateAfterSequence(afterSequence);
    if (this.disposed) throw new RunEventHubDisposedError();

    const state = this.createSubscription(
      { runId, includeDurable: true, includeTransient: true },
      undefined,
    );
    control.close = () => state.close("UNSUBSCRIBED");
    const onAbort = () => state.close("ABORTED");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (options.signal?.aborted) {
        state.close("ABORTED");
        return;
      }
      const highWatermark = await abortable(this.reader.latestSequence(runId), options.signal);
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) {
        throw new RunEventReplayError("Durable reader returned an invalid high watermark.");
      }
      if (afterSequence > highWatermark) {
        throw new EventCursorAheadError(runId, afterSequence, highWatermark);
      }

      let cursor = afterSequence;
      while (cursor < highWatermark && !state.closed) {
        const page = await abortable(
          this.reader.replay(runId, {
            afterSequence: cursor,
            throughSequence: highWatermark,
            limit: REPLAY_PAGE_SIZE,
          }),
          options.signal,
        );
        validateReplayPage(page, runId, cursor, highWatermark);
        if (page.length === 0) break;
        for (const event of page) {
          cursor = event.durability.sequence;
          yield event;
        }
        if (page.length < REPLAY_PAGE_SIZE) break;
      }

      if (state.closed) return;
      for (const event of state.queue.drain()) {
        if (!isDurable(event)) continue;
        if (event.durability.sequence <= highWatermark) continue;
        if (event.durability.sequence <= cursor) {
          throw new RunEventReplayError("Buffered durable replay is not strictly increasing.");
        }
        cursor = event.durability.sequence;
        yield event;
      }

      while (!state.closed) {
        const event = await state.queue.next();
        if (event === undefined) return;
        yield event;
      }
    } finally {
      control.close = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      state.close(state.closed ? (state.queue.closeReason ?? "ABORTED") : "UNSUBSCRIBED");
    }
  }
}

function validateSubscriberQueuePolicy(policy: SubscriberQueuePolicy): void {
  if (!Number.isSafeInteger(policy.maxPendingItems) || policy.maxPendingItems <= 0) {
    throw new RangeError("maxPendingItems must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.maxPendingBytes) || policy.maxPendingBytes <= 0) {
    throw new RangeError("maxPendingBytes must be a positive safe integer");
  }
}

function validateAfterSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("afterSequence must be a non-negative safe integer");
  }
}

function validateReplayPage(
  page: readonly DurableRunEvent[],
  runId: RunId,
  previousSequence: number,
  highWatermark: number,
): void {
  let previous = previousSequence;
  for (const event of page) {
    if (event.runId !== runId) {
      throw new RunEventReplayError("Durable replay returned an event for another Run.");
    }
    const sequence = event.durability.sequence;
    if (sequence <= previous || sequence > highWatermark) {
      throw new RunEventReplayError("Durable replay sequences must be strictly increasing.");
    }
    previous = sequence;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new DOMException("The event stream was aborted.", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("The event stream was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
