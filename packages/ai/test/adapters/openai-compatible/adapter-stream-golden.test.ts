import { describe, expect, it } from "vitest";
import { AIError } from "../../../src/errors/ai-error.js";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  finishChunk,
  openAIChunk,
  sseBody,
  sseResponse,
  toolCallDelta,
  type CapturingTransport,
} from "../../support/openai-compatible-transport.js";
import type { AIAdapterEvent } from "../../../src/adapters/api-adapter-event.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../../../src/adapters/api-adapter.js";

const API_ID = "openai-compatible-chat";
const MODEL_REF = { provider: "compat-fixture", model: "fixture-model" };

/** Build the frozen adapter input for one turn over a controlled transport. */
function adapterInput(
  transport: CapturingTransport,
  overrides: Partial<ApiAdapterStreamInput> = {},
): ApiAdapterStreamInput {
  const descriptor = modelDescriptor({ ref: MODEL_REF, api: API_ID });
  return {
    model: descriptor,
    provider: {
      providerId: "compat-fixture",
      endpoint: "http://127.0.0.1:4321/v1",
      credentials: { apiKey: "fixture-key" },
      headers: {},
      queryParams: {},
      transport: { fetch: transport.fetch },
    },
    request: {
      model: descriptor,
      messages: [{ role: "user", content: "hello" }],
      settings: {
        maxOutputTokens: 128,
        reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
        cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
      },
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Run the adapter over a scripted SSE response and collect the adapter events. */
async function run(
  chunks: readonly Record<string, unknown>[],
  options: { readonly adapter?: ApiAdapter; readonly signal?: AbortSignal } = {},
): Promise<AIAdapterEvent[]> {
  const transport = capturingTransport(() => sseResponse(chunks));
  const adapter = options.adapter ?? createOpenAICompatibleApiAdapter();
  const events: AIAdapterEvent[] = [];

  for await (const event of adapter.stream(
    adapterInput(transport, options.signal === undefined ? {} : { signal: options.signal }),
  )) {
    events.push(event);
  }
  return events;
}

function types(events: readonly AIAdapterEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("OpenAI-compatible stream golden: text", () => {
  it("emits text deltas then a single adapter.finish", async () => {
    const events = await run([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: { role: "assistant", content: "Hel" },
      }),
      openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "lo" } }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "stop" }),
    ]);

    expect(types(events)).toEqual(["text.delta", "text.delta", "adapter.finish"]);
    expect(events[0]).toEqual({ type: "text.delta", payload: { text: "Hel" } });
    expect(events[1]).toEqual({ type: "text.delta", payload: { text: "lo" } });
    expect(events[2]).toMatchObject({
      type: "adapter.finish",
      payload: { finishReason: "STOP", providerReason: "stop" },
    });
  });

  it("never emits a gateway envelope event", async () => {
    const events = await run([
      openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "hi" } }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "stop" }),
    ]);

    for (const forbidden of ["stream.start", "stream.finish", "stream.error"]) {
      expect(types(events), forbidden).not.toContain(forbidden);
    }
  });

  it("never exposes provider reasoning content as public text", async () => {
    const events = await run([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: { reasoning_content: "secret chain of thought" },
      }),
      openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "answer" } }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "stop" }),
    ]);

    expect(types(events)).toEqual(["text.delta", "adapter.finish"]);
    expect(JSON.stringify(events)).not.toContain("chain of thought");
    expect(JSON.stringify(events)).not.toContain("reasoning");
  });
});

describe("OpenAI-compatible stream golden: tool calls", () => {
  it("emits one complete lifecycle for a single fragmented tool call", async () => {
    const events = await run([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: {
          tool_calls: [
            toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: '{"pa' }),
          ],
        },
      }),
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: { tool_calls: [toolCallDelta({ index: 0, arguments: 'th":"a.ts"}' })] },
      }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
    ]);

    expect(types(events)).toEqual([
      "tool_call.start",
      "tool_call.delta",
      "tool_call.delta",
      "tool_call.completed",
      "adapter.finish",
    ]);
    expect(events[0]).toEqual({
      type: "tool_call.start",
      payload: { toolCallId: "call-a", toolName: "read_file" },
    });
    expect(events.at(-2)).toEqual({
      type: "tool_call.completed",
      payload: { id: "call-a", name: "read_file", input: { path: "a.ts" } },
    });
    expect(events.at(-1)).toMatchObject({ payload: { finishReason: "TOOL_CALLS" } });
  });

  it("keeps parallel tool calls separate and completes each once", async () => {
    const events = await run([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: {
          tool_calls: [
            toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: '{"path":"a"}' }),
            toolCallDelta({
              index: 1,
              id: "call-b",
              name: "search_text",
              arguments: '{"query":"b"}',
            }),
          ],
        },
      }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
    ]);

    const completed = events.filter((event) => event.type === "tool_call.completed");
    expect(completed).toHaveLength(2);
    expect(completed.map((event) => (event.payload as { id: string }).id)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(events.filter((event) => event.type === "tool_call.start")).toHaveLength(2);
  });

  it("repairs a trailing comma without guessing anything else", async () => {
    const events = await run([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: {
          tool_calls: [
            toolCallDelta({
              index: 0,
              id: "call-a",
              name: "read_file",
              arguments: '{"path":"a.ts",}',
            }),
          ],
        },
      }),
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
    ]);

    expect(events.at(-2)).toEqual({
      type: "tool_call.completed",
      payload: { id: "call-a", name: "read_file", input: { path: "a.ts" } },
    });
  });

  it("fails closed on an ambiguous tool identity delta", async () => {
    // Two ids are already known, and this delta carries neither an id nor an index,
    // so it cannot be attributed to a call. Guessing would merge two tool calls.
    const transport = capturingTransport(() =>
      sseResponse([
        openAIChunk({
          id: "c1",
          model: "fixture-model",
          delta: {
            tool_calls: [
              toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: "{" }),
              toolCallDelta({ index: 1, id: "call-b", name: "search_text", arguments: "{" }),
            ],
          },
        }),
        openAIChunk({
          id: "c1",
          model: "fixture-model",
          delta: { tool_calls: [toolCallDelta({ arguments: '"x"}' })] },
        }),
        finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
      ]),
    );

    const adapter = createOpenAICompatibleApiAdapter();
    const failure = await capture(adapter, transport);

    expect(failure).toBeInstanceOf(AIError);
    expect((failure as AIError).code).toBe("AI_INVALID_RESPONSE");
    expect((failure as AIError).retryable).toBe(false);
  });

  it("fails closed on a whitespace tool-call id", async () => {
    const transport = capturingTransport(() =>
      sseResponse([
        openAIChunk({
          id: "c1",
          model: "fixture-model",
          delta: { tool_calls: [toolCallDelta({ index: 0, id: "   ", name: "read_file" })] },
        }),
        finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
      ]),
    );

    const failure = await capture(createOpenAICompatibleApiAdapter(), transport);

    expect((failure as AIError).code).toBe("AI_INVALID_RESPONSE");
  });
});

describe("OpenAI-compatible stream golden: finish and usage", () => {
  it("maps each known finish reason and preserves the native reason", async () => {
    // These are the real OpenAI wire values: the SDK normalises them, so a fixture
    // using the normalised spelling would silently exercise the `OTHER` path.
    const cases = [
      ["stop", "STOP"],
      ["length", "LENGTH"],
      ["tool_calls", "TOOL_CALLS"],
      ["content_filter", "CONTENT_FILTER"],
    ] as const;

    for (const [wireReason, mapped] of cases) {
      const events = await run([
        finishChunk({ id: "c1", model: "fixture-model", finishReason: wireReason }),
      ]);

      expect(events.at(-1), wireReason).toEqual({
        type: "adapter.finish",
        payload: { finishReason: mapped, providerReason: wireReason },
      });
    }
  });

  it("keeps a non-wire reason visible instead of losing it", async () => {
    // The adapter maps the value the SDK hands it, and the SDK only recognises the
    // real wire spellings. Anything else becomes OTHER while the native reason is
    // preserved, so a provider variant is diagnosable rather than silently dropped.
    const events = await run([
      finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool-calls" }),
    ]);

    expect(events.at(-1)).toEqual({
      type: "adapter.finish",
      payload: { finishReason: "OTHER", providerReason: "tool-calls" },
    });
  });

  it("maps an unknown finish reason to OTHER and keeps the native reason", async () => {
    const events = await run([
      finishChunk({
        id: "c1",
        model: "fixture-model",
        finishReason: "insufficient_system_resource",
      }),
    ]);

    expect(events.at(-1)).toEqual({
      type: "adapter.finish",
      payload: { finishReason: "OTHER", providerReason: "insufficient_system_resource" },
    });
  });

  it("emits usage updates and a finalUsage on adapter.finish", async () => {
    const events = await run([
      openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "hi" } }),
      finishChunk({
        id: "c1",
        model: "fixture-model",
        finishReason: "stop",
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }),
    ]);

    const finish = events.at(-1);
    expect(finish?.type).toBe("adapter.finish");
    expect(
      (finish as { payload: { finalUsage?: Record<string, number> } }).payload.finalUsage,
    ).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    });
  });
});

describe("OpenAI-compatible stream golden: failures", () => {
  it("normalizes a network failure as AI_NETWORK", async () => {
    const transport = capturingTransport(() => Promise.reject(new Error("socket closed")));
    const failure = await capture(createOpenAICompatibleApiAdapter(), transport);

    expect((failure as AIError).code).toBe("AI_NETWORK");
    expect((failure as AIError).retryable).toBe(true);
  });

  it("normalizes an HTTP 401 as AI_AUTHENTICATION", async () => {
    const transport = capturingTransport(
      () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const failure = await capture(createOpenAICompatibleApiAdapter(), transport);

    expect((failure as AIError).code).toBe("AI_AUTHENTICATION");
    expect((failure as AIError).retryable).toBe(false);
  });

  it("normalizes an HTTP 429 as a retryable AI_RATE_LIMIT", async () => {
    const transport = capturingTransport(
      () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
    );
    const failure = await capture(createOpenAICompatibleApiAdapter(), transport);

    expect((failure as AIError).code).toBe("AI_RATE_LIMIT");
    expect((failure as AIError).retryable).toBe(true);
    expect((failure as AIError).retryAfterMs).toBe(3_000);
  });

  it("normalizes a context overflow body as AI_CONTEXT_OVERFLOW", async () => {
    const transport = capturingTransport(
      () =>
        new Response(
          JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }),
          { status: 400 },
        ),
    );
    const failure = await capture(createOpenAICompatibleApiAdapter(), transport);

    expect((failure as AIError).code).toBe("AI_CONTEXT_OVERFLOW");
    expect((failure as AIError).retryable).toBe(false);
  });

  it("fails a partial tool call closed when the stream breaks", async () => {
    const body = `${sseBody([
      openAIChunk({
        id: "c1",
        model: "fixture-model",
        delta: {
          tool_calls: [
            toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: '{"pa' }),
          ],
        },
      }),
    ])}data: {"broken`;
    const transport = capturingTransport(
      () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const adapter = createOpenAICompatibleApiAdapter();
    const events: AIAdapterEvent[] = [];
    let failure: unknown;

    try {
      for await (const event of adapter.stream(adapterInput(transport))) events.push(event);
    } catch (error) {
      failure = error;
    }

    // A partially received tool call must never produce a completed call.
    expect(events.filter((event) => event.type === "tool_call.completed")).toEqual([]);
    expect(failure === undefined || failure instanceof AIError).toBe(true);
  });

  it("reports a gateway-owned abort as AI_ABORTED, not as an invalid response", async () => {
    const controller = new AbortController();
    const transport = capturingTransport(() => {
      controller.abort();
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.error(new Error("aborted"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const adapter = createOpenAICompatibleApiAdapter();
    const failure = await capture(adapter, transport, controller.signal);

    expect(failure).toBeInstanceOf(AIError);
    expect((failure as AIError).code).not.toBe("AI_INVALID_RESPONSE");
  });
});

/** Drain an adapter and return the failure it threw, if any. */
async function capture(
  adapter: ApiAdapter,
  transport: CapturingTransport,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    for await (const event of adapter.stream(
      adapterInput(transport, signal === undefined ? {} : { signal }),
    )) {
      void event;
    }
  } catch (error) {
    return error;
  }
  return undefined;
}
