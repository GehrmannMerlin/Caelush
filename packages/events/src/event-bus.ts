import type { AgentEvent, RunId } from "@caelush/protocol";
import type { DurableEventStore } from "./durable-event-store.js";
import type { DurableAgentEvent, DurableEventDraft } from "./event-draft.js";
import { AsyncEventQueue } from "./event-stream.js";
import type { EventStream, EventWatchOptions } from "./event-stream.js";

export type EventListener = (event: AgentEvent) => void;

const REPLAY_PAGE_SIZE = 1000;

export interface EventSubscriptionOptions {
  readonly onError?: (error: unknown, event: AgentEvent) => void;
}

interface Subscriber {
  readonly listener: EventListener;
  readonly onError?: (error: unknown, event: AgentEvent) => void;
}

export class EventBus {
  private readonly subscribers = new Map<RunId, Set<Subscriber>>();

  constructor(private readonly durableStore: DurableEventStore) {}

  async publish(event: AgentEvent | DurableEventDraft): Promise<AgentEvent> {
    if (event.durability.kind === "DURABLE") {
      const durable = await this.durableStore.append(event as unknown as DurableEventDraft);
      this.notify(durable as AgentEvent);
      return durable as AgentEvent;
    }

    const ephemeral = event as unknown as AgentEvent;
    this.notify(ephemeral);
    return ephemeral;
  }

  subscribe(
    runId: RunId,
    listener: EventListener,
    options: EventSubscriptionOptions = {},
  ): () => void {
    const subscriber: Subscriber = options.onError
      ? { listener, onError: options.onError }
      : { listener };
    let runSubscribers = this.subscribers.get(runId);
    if (!runSubscribers) {
      runSubscribers = new Set();
      this.subscribers.set(runId, runSubscribers);
    }
    runSubscribers.add(subscriber);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      runSubscribers?.delete(subscriber);
      if (runSubscribers?.size === 0) this.subscribers.delete(runId);
    };
  }

  watch(runId: RunId, options: EventWatchOptions = {}): EventStream {
    return this.watchEvents(runId, options);
  }

  private async *watchEvents(runId: RunId, options: EventWatchOptions): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const afterSequence = options.afterSequence ?? 0;
    let catchingUp = true;
    let aborted = options.signal?.aborted ?? false;
    const buffered: AgentEvent[] = [];
    const onEvent = (event: AgentEvent) => {
      if (catchingUp) buffered.push(event);
      else queue.push(event);
    };
    const onAbort = () => {
      aborted = true;
      queue.close();
    };
    const unsubscribe = this.subscribe(runId, onEvent);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (aborted) return;
      const replay: DurableAgentEvent[] = [];
      let replayCursor = afterSequence;
      while (true) {
        const page = await this.durableStore.replay(runId, {
          afterSequence: replayCursor,
          limit: REPLAY_PAGE_SIZE,
        });
        replay.push(...page);
        if (page.length < REPLAY_PAGE_SIZE) break;

        const nextCursor = Math.max(...page.map((event) => event.durability.sequence));
        if (nextCursor <= replayCursor) break;
        replayCursor = nextCursor;
      }
      if (aborted) return;

      const seen = new Set<number>();
      const orderedReplay = [...replay].sort(
        (left, right) => left.durability.sequence - right.durability.sequence,
      );
      for (const event of orderedReplay) {
        if (event.durability.sequence <= afterSequence || seen.has(event.durability.sequence)) {
          continue;
        }
        seen.add(event.durability.sequence);
        yield event;
      }

      catchingUp = false;
      const orderedBuffered = [...buffered].sort((left, right) => {
        if (left.durability.kind === "DURABLE" && right.durability.kind === "DURABLE") {
          return left.durability.sequence - right.durability.sequence;
        }
        if (left.durability.kind === "DURABLE") return -1;
        if (right.durability.kind === "DURABLE") return 1;
        return 0;
      });
      for (const event of orderedBuffered) {
        if (event.durability.kind === "DURABLE") {
          if (event.durability.sequence <= afterSequence || seen.has(event.durability.sequence)) {
            continue;
          }
          seen.add(event.durability.sequence);
        }
        yield event;
      }

      while (!aborted) {
        const next = await queue.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      queue.close();
    }
  }

  private notify(event: AgentEvent): void {
    const runSubscribers = this.subscribers.get(event.runId);
    if (!runSubscribers) return;

    for (const subscriber of [...runSubscribers]) {
      try {
        subscriber.listener(event);
      } catch (error) {
        subscriber.onError?.(error, event);
      }
    }
  }
}
