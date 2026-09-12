import type { AIAdapterEvent } from "../../src/adapters/api-adapter-event.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../../src/adapters/api-adapter.js";
import type { ApiId } from "../../src/ids/api-id.js";

/** A fake adapter that records every invocation, so "no retry" is provable. */
export interface FakeAdapter extends ApiAdapter {
  /** Every input the gateway handed to `stream()`, in call order. */
  readonly calls: readonly ApiAdapterStreamInput[];
  callCount(): number;
}

/** How a fake adapter should behave on one call. */
export type FakeAdapterScript = (
  input: ApiAdapterStreamInput,
  callIndex: number,
) => AsyncIterable<AIAdapterEvent>;

/**
 * Build a fake adapter.
 *
 * A real adapter performs exactly one provider turn; the fake does the same, so
 * counting its invocations is a faithful test of gateway retry and failover
 * behaviour.
 */
export function createFakeAdapter(id: ApiId, script: FakeAdapterScript): FakeAdapter {
  const calls: ApiAdapterStreamInput[] = [];

  return {
    id,
    calls,
    callCount: () => calls.length,
    stream(input: ApiAdapterStreamInput): AsyncIterable<AIAdapterEvent> {
      calls.push(input);
      return script(input, calls.length - 1);
    },
  };
}

/** Turn a fixed list of adapter events into an async iterable. */
export function adapterEvents(...events: readonly AIAdapterEvent[]): AsyncIterable<AIAdapterEvent> {
  return (async function* generate(): AsyncGenerator<AIAdapterEvent> {
    for (const event of events) yield event;
  })();
}

/** Yield the events, then throw, so a mid-stream failure can be tested. */
export function adapterEventsThenThrow(
  events: readonly AIAdapterEvent[],
  error: unknown,
): AsyncIterable<AIAdapterEvent> {
  return (async function* generate(): AsyncGenerator<AIAdapterEvent> {
    for (const event of events) yield event;
    throw error;
  })();
}

/** Text plus a normal stop: the smallest complete successful turn. */
export function textTurn(text: string): readonly AIAdapterEvent[] {
  return [
    { type: "text.delta", payload: { text } },
    { type: "adapter.finish", payload: { finishReason: "STOP" } },
  ];
}

/** A complete tool-call turn. */
export function toolTurn(): readonly AIAdapterEvent[] {
  return [
    { type: "text.delta", payload: { text: "calling" } },
    { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
    { type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path":"a.ts"}' } },
    {
      type: "tool_call.completed",
      payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
    },
    { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } },
  ];
}

/** Yield forever until aborted, so cancellation and timeout can be observed. */
export function hangingAdapter(): AsyncIterable<AIAdapterEvent> {
  return (async function* generate(): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text: "start" } };
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    });
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  })();
}
