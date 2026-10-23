import { describe, expect, it } from "vitest";

import { createAIModelTurnAssembler } from "../src/stream/turn-assembler.js";
import { createAIGateway } from "../src/gateway/ai-gateway.js";
import { createOpenAICompatibleApiAdapter } from "../src/adapters/openai-compatible/index.js";
import { modelDescriptor } from "./support/fixtures.js";
import { testGatewayDependencies, testProviderBinding } from "./support/gateway-fixtures.js";
import {
  capturingTransport,
  finishChunk,
  openAIChunk,
  sseResponse,
  toolCallDelta,
} from "./support/openai-compatible-transport.js";
import type { AIAdapterEvent } from "../src/adapters/api-adapter-event.js";
import type { AIStreamEvent } from "../src/stream/events.js";
import type { AIReceivedToolRequest } from "../src/tools/received-tool-request.js";
import { AI_RECEIVED_TOOL_REQUEST_KINDS } from "../src/tools/received-tool-request.js";

/**
 * The typed "request I received but cannot execute" contract.
 *
 * These tests are the T1 boundary: the real pinned SDK, a real SSE body through an in-memory
 * transport, and the real adapter. A malformed argument string must become a *value* the model can
 * be told about, not a thrown `AI_INVALID_RESPONSE` that ends the Run.
 */

const API_ID = "openai-compatible-chat";
const MODEL_REF = { provider: "compat-fixture", model: "fixture-model" };

const readTool = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: {
    type: "object" as const,
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

function descriptor() {
  return modelDescriptor({ ref: MODEL_REF, api: API_ID });
}

function adapterInput(
  transport: { readonly fetch: typeof fetch },
  overrides: Record<string, unknown> = {},
) {
  const model = descriptor();
  return {
    model,
    provider: {
      providerId: "compat-fixture",
      endpoint: "http://127.0.0.1:4321/v1",
      credentials: { apiKey: "fixture-key" },
      headers: {},
      queryParams: {},
      transport: { fetch: transport.fetch },
    },
    request: {
      model,
      messages: [{ role: "user" as const, content: "read the file" }],
      tools: [readTool],
      settings: {
        maxOutputTokens: 128,
        reasoning: { effective: "OFF" as const },
        cache: { effective: "NONE" as const, mode: "EXACT" as const },
      },
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** One tool-call chunk that emits every call in a single delta, then a tool_calls finish. */
function toolCallsResponse(
  calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[],
  finishReason = "tool_calls",
): Response {
  return sseResponse([
    openAIChunk({
      id: "chunk-1",
      model: MODEL_REF.model,
      delta: {
        tool_calls: calls.map((call, index) =>
          toolCallDelta({
            index,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          }),
        ),
      },
    }),
    finishChunk({ id: "chunk-1", model: MODEL_REF.model, finishReason }),
  ]);
}

async function adapterEvents(response: Response): Promise<AIAdapterEvent[]> {
  const transport = capturingTransport(() => response);
  const events: AIAdapterEvent[] = [];
  for await (const event of createOpenAICompatibleApiAdapter().stream(
    adapterInput(transport) as never,
  )) {
    if (event.type === "provider.activity") continue;
    events.push(event);
  }
  return events;
}

async function gatewayEvents(response: Response): Promise<AIStreamEvent[]> {
  const transport = capturingTransport(() => response);
  const model = descriptor();
  const gateway = createAIGateway(
    testGatewayDependencies({
      descriptors: [model],
      adapters: [createOpenAICompatibleApiAdapter()],
      providers: [
        testProviderBinding({
          id: MODEL_REF.provider,
          endpoint: "http://127.0.0.1:4321/v1",
          defaultApi: API_ID,
          allowUnknownModels: true,
          transport: { fetch: transport.fetch } as never,
        }),
      ],
    }),
  );
  const stream = await gateway.stream({
    model: MODEL_REF,
    messages: [{ role: "user", content: "read the file" }],
    tools: [readTool],
    settings: { maxOutputTokens: 128 },
  } as never);
  const events: AIStreamEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

describe("AIReceivedToolRequest", () => {
  it("has exactly the two closed kinds", () => {
    expect([...AI_RECEIVED_TOOL_REQUEST_KINDS]).toEqual(["EXECUTABLE", "INVALID_ARGUMENTS"]);
  });

  it("keeps a well-formed object executable and never invents a rejection", async () => {
    const events = await adapterEvents(
      toolCallsResponse([{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }]),
    );
    expect(events.map((event) => event.type)).toEqual([
      "tool_call.start",
      "tool_call.delta",
      "tool_call.completed",
      "adapter.finish",
    ]);
  });

  it("keeps the sanctioned trailing-comma repair executable", async () => {
    const events = await adapterEvents(
      toolCallsResponse([{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts",}' }]),
    );
    const completed = events.find((event) => event.type === "tool_call.completed");
    expect(completed).toMatchObject({ payload: { id: "call-1", input: { path: "a.ts" } } });
  });

  for (const [label, args, code] of [
    ["null", "null", "EXPECTED_OBJECT"],
    ["array", "[]", "EXPECTED_OBJECT"],
    ["bare string", '"a.ts"', "EXPECTED_OBJECT"],
    ["truncated object", '{"path":"a.ts"', "MALFORMED_JSON"],
    ["unquoted key", "{path:1}", "MALFORMED_JSON"],
  ] as const) {
    it(`reports ${label} as a typed rejection instead of failing the stream`, async () => {
      const events = await adapterEvents(
        toolCallsResponse([{ id: "call-1", name: "read_file", arguments: args }]),
      );
      expect(events.map((event) => event.type)).toEqual([
        "tool_call.start",
        "tool_call.delta",
        "tool_call.rejected",
        "adapter.finish",
      ]);
      const rejected = events.find((event) => event.type === "tool_call.rejected") as Extract<
        AIAdapterEvent,
        { type: "tool_call.rejected" }
      >;
      expect(rejected.payload.toolCallId).toBe("call-1");
      expect(rejected.payload.toolName).toBe("read_file");
      expect(rejected.payload.issue.code).toBe(code);
      expect(rejected.payload.issue.argumentBytes).toBe(Buffer.byteLength(args, "utf8"));
    });
  }

  it("reports an argument string cut off by a provider length stop as incomplete", async () => {
    const events = await adapterEvents(
      toolCallsResponse(
        [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts' }],
        "length",
      ),
    );
    const rejected = events.find((event) => event.type === "tool_call.rejected") as Extract<
      AIAdapterEvent,
      { type: "tool_call.rejected" }
    >;
    expect(rejected.payload.issue.code).toBe("INCOMPLETE_ARGUMENTS");
  });

  it("keeps a mixed batch in source order and never drops the valid call", async () => {
    const events = await adapterEvents(
      toolCallsResponse([
        { id: "good", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "bad", name: "read_file", arguments: '{"path":' },
        { id: "good-2", name: "read_file", arguments: '{"path":"b.ts"}' },
      ]),
    );
    // The SDK announces every tool input first and settles them afterwards, so the lifecycle
    // markers come in two groups while the request order is preserved inside each group.
    expect(events.map((event) => event.type)).toEqual([
      "tool_call.start",
      "tool_call.delta",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.completed",
      "tool_call.rejected",
      "tool_call.completed",
      "adapter.finish",
    ]);
    expect(
      events
        .filter((event) => event.type === "tool_call.start")
        .map((event) => (event.payload as { readonly toolCallId: string }).toolCallId),
    ).toEqual(["good", "bad", "good-2"]);
  });

  it("still fails the stream when the provider repeats a tool call id", async () => {
    await expect(
      adapterEvents(
        toolCallsResponse([
          { id: "same", name: "read_file", arguments: '{"path":"a.ts"}' },
          { id: "same", name: "read_file", arguments: '{"path":' },
        ]),
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });
});

describe("turn result tool requests", () => {
  it("projects a mixed batch onto ordered toolRequests with toolCalls as the executable view", async () => {
    const events = await gatewayEvents(
      toolCallsResponse([
        { id: "good", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "bad", name: "read_file", arguments: '{"path":' },
      ]),
    );
    const assembler = createAIModelTurnAssembler();
    for (const event of events) assembler.accept(event);
    const result = assembler.result();

    expect(result.toolCalls.map((call) => call.id)).toEqual(["good"]);
    const requests: readonly AIReceivedToolRequest[] = result.toolRequests;
    expect(requests).toMatchObject([
      { kind: "EXECUTABLE", sourceOrdinal: 0, call: { id: "good" } },
      {
        kind: "INVALID_ARGUMENTS",
        sourceOrdinal: 1,
        id: "bad",
        name: "read_file",
        issue: { code: "MALFORMED_JSON" },
      },
    ]);
    // The rejected request is part of the durable-shaped assistant items, in source order.
    expect(result.assistantItems?.[0]?.content.map((part) => part.type)).toEqual([
      "tool-call",
      "tool-call-rejected",
    ]);
  });

  it("has no result at all when the stream never reached a trusted finish", async () => {
    const assembler = createAIModelTurnAssembler();
    assembler.accept({
      type: "stream.start",
      payload: {
        callId: "llm_01a15000-0000-7000-8000-000000000001" as never,
        providerId: "compat-fixture" as never,
        model: descriptor().ref,
        resolution: {} as never,
      },
    });
    assembler.accept({
      type: "tool_call.start",
      payload: { toolCallId: "good", toolName: "read_file" },
    });
    assembler.accept({
      type: "tool_call.completed",
      payload: { id: "good", name: "read_file", input: { path: "a.ts" } },
    });
    expect(() => assembler.result()).toThrowError(/did not finish/);
  });
});
