import { describe, expect, it } from "vitest";
import { AIError, createAIError } from "../src/errors/ai-error.js";
import { createAIGateway } from "../src/gateway/ai-gateway.js";
import { modelDescriptor } from "./support/fixtures.js";
import {
  adapterEvents,
  adapterEventsThenThrow,
  createFakeAdapter,
  textTurn,
  toolTurn,
} from "./support/fake-adapter.js";
import { testGatewayDependencies, testProviderBinding } from "./support/gateway-fixtures.js";
import type { AIAdapterEvent } from "../src/adapters/api-adapter-event.js";
import type { AIGateway } from "../src/gateway/ai-gateway.js";
import type { AIModelRequest } from "../src/request/model-request.js";
import type { AIStreamEvent } from "../src/stream/events.js";
import type { ApiAdapterStreamInput } from "../src/adapters/api-adapter.js";
import type { FakeAdapter } from "./support/fake-adapter.js";

const SECRET = "fake-api-secret-123";

const MODEL = modelDescriptor({
  ref: { provider: "test", model: "model-a" },
  api: "test-api",
  reasoning: { supportedLevels: ["LOW", "MEDIUM"], supportsSummary: "SUPPORTED" },
  cache: { supportedRetentions: ["SHORT"] },
});

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "test", model: "model-a" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

function gatewayWith(adapter: FakeAdapter): AIGateway {
  return createAIGateway(testGatewayDependencies({ descriptors: [MODEL], adapters: [adapter] }));
}

async function collect(events: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const collected: AIStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function types(events: readonly AIStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Yield the events, then wait for the abort signal, then fail like a transport. */
function hangUntilAborted(events: readonly AIAdapterEvent[], onAbort?: () => void) {
  return async function* script(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    for (const event of events) yield event;
    await new Promise<void>((resolve) => {
      // The signal may already have fired while this generator was suspended at a
      // yield, so the already-aborted case has to be handled explicitly.
      if (input.signal.aborted) {
        onAbort?.();
        resolve();
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => {
          onAbort?.();
          resolve();
        },
        { once: true },
      );
    });
    throw new Error("transport unwound");
  };
}

describe("AIGateway runtime forwarding", () => {
  it("emits stream.start first, then forwards the turn and finishes", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const events = await collect((await gatewayWith(adapter).stream(request())).events);

    expect(types(events)).toEqual(["stream.start", "text.delta", "stream.finish"]);
    expect(adapter.callCount()).toBe(1);

    const start = events[0];
    expect(start?.type).toBe("stream.start");
    if (start?.type !== "stream.start") throw new Error("unreachable");
    expect(start.payload.providerId).toBe("test");
    expect(start.payload.model).toEqual({ provider: "test", model: "model-a" });
    expect(start.payload.resolution.api).toBe("test-api");
    expect(start.payload.resolution.maxOutputTokens).toBe(MODEL.limits.maxOutputTokens);
    expect(start.payload.resolution.reasoning).toEqual({
      mode: "NOT_REQUESTED",
      policy: "PREFER_BUDGET",
    });
    expect(start.payload.resolution.cache).toEqual({
      requested: "NONE",
      effective: "NONE",
      mode: "EXACT",
    });
  });

  it("forwards reasoning summaries, tool lifecycles and usage", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEvents(
        { type: "reasoning.summary.delta", payload: { text: "considering" } },
        ...toolTurn(),
        { type: "usage", payload: { inputTokens: 7 } },
      ),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);

    expect(types(events)).toEqual([
      "stream.start",
      "reasoning.summary.delta",
      "text.delta",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.completed",
      "usage",
      "stream.finish",
    ]);

    const finish = events.at(-1);
    if (finish?.type !== "stream.finish") throw new Error("unreachable");
    expect(finish.payload.finishReason).toBe("TOOL_CALLS");
  });

  it("carries finalUsage and providerReason on stream.finish", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEvents(
        { type: "text.delta", payload: { text: "hi" } },
        {
          type: "adapter.finish",
          payload: {
            finishReason: "STOP",
            finalUsage: { inputTokens: 5 },
            providerReason: "vendor-stop",
          },
        },
      ),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);
    const finish = events.at(-1);

    if (finish?.type !== "stream.finish") throw new Error("unreachable");
    expect(finish.payload.finalUsage).toEqual({ inputTokens: 5 });
    expect(finish.payload.providerReason).toBe("vendor-stop");
  });

  it("preserves OTHER as a finish reason without downgrading it to STOP", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEvents({ type: "adapter.finish", payload: { finishReason: "OTHER" } }),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);
    const finish = events.at(-1);

    if (finish?.type !== "stream.finish") throw new Error("unreachable");
    expect(finish.payload.finishReason).toBe("OTHER");
  });

  it("passes the resolved request and signal to the adapter", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hi")));
    await collect(
      (await gatewayWith(adapter).stream(request({ settings: { temperature: 0.5 } }))).events,
    );

    const input = adapter.calls[0];
    expect(input?.model.ref).toEqual({ provider: "test", model: "model-a" });
    expect(input?.request.settings.temperature).toBe(0.5);
    expect(input?.provider.credentials).toEqual({ apiKey: "test-api-key" });
    expect(input?.provider.endpoint).toBe("https://api.test.example/v1");
    expect(input?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("AIGateway runtime error boundary", () => {
  it("turns an adapter AIError into a sanitized stream.error", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEventsThenThrow(
        [{ type: "text.delta", payload: { text: "partial" } }],
        createAIError("AI_NETWORK", "connection reset"),
      ),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);

    expect(types(events)).toEqual(["stream.start", "text.delta", "stream.error"]);
    const error = events.at(-1);
    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error).toEqual({
      code: "AI_NETWORK",
      message: "connection reset",
      providerId: "test",
      model: { provider: "test", model: "model-a" },
      retryable: true,
    });
    expect(adapter.callCount()).toBe(1);
  });

  it("turns an unknown throw into AI_PROVIDER_ERROR without leaking the raw error", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEventsThenThrow([], new Error(`upstream body with ${SECRET}`)),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);
    const error = events.at(-1);

    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error.code).toBe("AI_PROVIDER_ERROR");
    expect(error.payload.error.retryable).toBe(false);
    expect(JSON.stringify(error.payload.error)).not.toContain(SECRET);
    expect(error.payload.error.message).not.toContain("upstream body");
  });

  it("redacts a credential that leaked into a provider message", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEventsThenThrow(
        [],
        createAIError("AI_AUTHENTICATION", `rejected key api_key=${SECRET}`),
      ),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);
    const error = events.at(-1);

    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(JSON.stringify(error.payload.error)).not.toContain(SECRET);
  });

  it("fails closed when the adapter ends without adapter.finish", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEvents({ type: "text.delta", payload: { text: "half" } }),
    );
    const events = await collect((await gatewayWith(adapter).stream(request())).events);
    const error = events.at(-1);

    expect(types(events)).toEqual(["stream.start", "text.delta", "stream.error"]);
    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed when the adapter breaks the tool-call lifecycle", async () => {
    const cases: readonly (readonly AIAdapterEvent[])[] = [
      [
        { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "t" } },
        { type: "tool_call.delta", payload: { toolCallId: "c1", delta: "x" } },
        { type: "tool_call.completed", payload: { id: "c1", name: "t", input: {} } },
        { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "t" } },
      ],
      [{ type: "tool_call.delta", payload: { toolCallId: "ghost", delta: "x" } }],
      [{ type: "tool_call.completed", payload: { id: "ghost", name: "t", input: {} } }],
      [
        { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "t" } },
        { type: "tool_call.completed", payload: { id: "c1", name: "other", input: {} } },
      ],
      [
        { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "t" } },
        { type: "adapter.finish", payload: { finishReason: "STOP" } },
      ],
      [
        { type: "adapter.finish", payload: { finishReason: "STOP" } },
        { type: "adapter.finish", payload: { finishReason: "STOP" } },
      ],
    ];

    for (const scripted of cases) {
      const adapter = createFakeAdapter("test-api", () => adapterEvents(...scripted));
      const events = await collect((await gatewayWith(adapter).stream(request())).events);
      const error = events.at(-1);

      expect(error?.type, JSON.stringify(scripted)).toBe("stream.error");
      if (error?.type !== "stream.error") throw new Error("unreachable");
      expect(error.payload.error.code).toBe("AI_INVALID_RESPONSE");
      // The stream must terminate: nothing follows the terminal error.
      expect(events.filter((event) => event.type === "stream.error")).toHaveLength(1);
    }
  });
});

describe("AIGateway abort and timeout", () => {
  it("aborts on the caller's signal and reports AI_ABORTED", async () => {
    const controller = new AbortController();
    let adapterSawAbort = false;
    const adapter = createFakeAdapter("test-api", (input) =>
      hangUntilAborted([{ type: "text.delta", payload: { text: "start" } }], () => {
        adapterSawAbort = true;
      })(input),
    );

    const stream = await gatewayWith(adapter).stream(request(), { signal: controller.signal });
    const events: AIStreamEvent[] = [];
    for await (const event of stream.events) {
      events.push(event);
      if (event.type === "text.delta") controller.abort();
    }

    const error = events.at(-1);
    expect(adapterSawAbort).toBe(true);
    expect(types(events)).toEqual(["stream.start", "text.delta", "stream.error"]);
    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error.code).toBe("AI_ABORTED");
  });

  it("aborts on the invocation timeout", async () => {
    const adapter = createFakeAdapter("test-api", (input) =>
      hangUntilAborted([{ type: "text.delta", payload: { text: "start" } }])(input),
    );

    const events = await collect(
      (await gatewayWith(adapter).stream(request(), { timeoutMs: 20 })).events,
    );
    const error = events.at(-1);

    expect(types(events)).toEqual(["stream.start", "text.delta", "stream.error"]);
    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error.code).toBe("AI_TIMEOUT");
    expect(error.payload.error.retryable).toBe(true);
  });

  it("reports an external abort as AI_ABORTED, not as a transport symptom", async () => {
    const controller = new AbortController();
    const adapter = createFakeAdapter("test-api", (input) =>
      hangUntilAborted([{ type: "text.delta", payload: { text: "start" } }])(input),
    );

    const stream = await gatewayWith(adapter).stream(request(), { signal: controller.signal });
    const events: AIStreamEvent[] = [];
    for await (const event of stream.events) {
      events.push(event);
      if (event.type === "text.delta") controller.abort();
    }

    const error = events.at(-1);
    if (error?.type !== "stream.error") throw new Error("unreachable");
    expect(error.payload.error.code).toBe("AI_ABORTED");
    expect(error.payload.error.retryable).toBe(false);
  });

  it("cleans up when the consumer stops reading", async () => {
    let closed = false;
    let aborted = false;
    const adapter = createFakeAdapter("test-api", (input) => {
      // Observe the transport signal from the start, so the test proves the
      // gateway aborted it rather than relying on where the adapter happens to be
      // suspended.
      input.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );

      return (async function* script(): AsyncGenerator<AIAdapterEvent> {
        try {
          yield { type: "text.delta", payload: { text: "one" } };
          yield { type: "text.delta", payload: { text: "two" } };
          yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
        } finally {
          closed = true;
        }
      })();
    });

    const stream = await gatewayWith(adapter).stream(request());
    const iterator = stream.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("stream.start");
    expect((await iterator.next()).value?.type).toBe("text.delta");
    await iterator.return?.();

    expect(aborted).toBe(true);
    expect(closed).toBe(true);
    // A cancelled consumer gets no synthesized stream.error and no further events.
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("AIGateway makes exactly one provider turn", () => {
  it("never retries a retryable failure", async () => {
    for (const code of ["AI_RATE_LIMIT", "AI_NETWORK", "AI_TIMEOUT"] as const) {
      const adapter = createFakeAdapter("test-api", () =>
        adapterEventsThenThrow([], createAIError(code, "transient")),
      );
      const events = await collect((await gatewayWith(adapter).stream(request())).events);
      const error = events.at(-1);

      if (error?.type !== "stream.error") throw new Error("unreachable");
      expect(error.payload.error.code).toBe(code);
      expect(error.payload.error.retryable).toBe(true);
      expect(adapter.callCount(), code).toBe(1);
    }
  });

  it("never fails over to another provider or model", async () => {
    const seen: string[] = [];
    const shared = createFakeAdapter("test-api", (input) => {
      seen.push(`${input.provider.providerId}/${input.model.ref.model}`);
      return adapterEventsThenThrow([], createAIError("AI_NETWORK", "provider a is down"));
    });
    const gateway = createAIGateway(
      testGatewayDependencies({
        descriptors: [
          modelDescriptor({ ref: { provider: "provider-a", model: "model-a" }, api: "test-api" }),
          modelDescriptor({ ref: { provider: "provider-b", model: "model-b" }, api: "test-api" }),
        ],
        providers: [
          testProviderBinding({ id: "provider-a" }),
          testProviderBinding({ id: "provider-b" }),
        ],
        adapters: [shared],
      }),
    );

    const events = await collect(
      (
        await gateway.stream({
          model: { provider: "provider-a", model: "model-a" },
          messages: [{ role: "user", content: "hello" }],
        })
      ).events,
    );

    expect(events.at(-1)?.type).toBe("stream.error");
    expect(seen).toEqual(["provider-a/model-a"]);
    expect(shared.callCount()).toBe(1);
  });
});

describe("AIGateway.complete", () => {
  it("consumes the same stream and returns the assembled turn", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEvents(...textTurn("hello"), { type: "usage", payload: { inputTokens: 3 } }),
    );
    const result = await gatewayWith(adapter).complete(request());

    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("STOP");
    expect(result.usage).toEqual({ inputTokens: 3 });
    expect(result.providerId).toBe("test");
    expect(result.toolCalls).toEqual([]);
    expect(adapter.callCount()).toBe(1);
  });

  it("returns completed tool calls", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...toolTurn()));
    const result = await gatewayWith(adapter).complete(request());

    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]);
    expect(result.finishReason).toBe("TOOL_CALLS");
    expect(result.text).toBe("calling");
  });

  it("rejects with AIError when the stream fails", async () => {
    const adapter = createFakeAdapter("test-api", () =>
      adapterEventsThenThrow([], createAIError("AI_CONTEXT_OVERFLOW", "too long")),
    );

    await expect(gatewayWith(adapter).complete(request())).rejects.toBeInstanceOf(AIError);
    await gatewayWith(adapter)
      .complete(request())
      .catch((error: unknown) => {
        expect((error as AIError).code).toBe("AI_CONTEXT_OVERFLOW");
        // The AI layer only reports overflow: it never compacts or retries.
        expect((error as AIError).retryable).toBe(false);
      });
    expect(adapter.callCount()).toBe(2);
  });

  it("propagates a preflight rejection", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const gateway = gatewayWith(adapter);

    await expect(
      gateway.complete(request({ model: { provider: "test", model: "missing" } })),
    ).rejects.toBeInstanceOf(AIError);
    expect(adapter.callCount()).toBe(0);
  });
});
