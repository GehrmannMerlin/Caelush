import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import { LLMInvalidResponseError } from "../src/index.js";
import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
} from "../src/index.js";
import {
  finishChunk,
  openAIChunk,
  sseResponse,
  toolCallDelta,
} from "./support/openai-compatible-sse.js";

const model = { provider: "compat-fixture", model: "fixture-model" };
const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
};
const searchTextTool: ToolDefinition = {
  name: "search_text",
  description: "Search text.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
};

function createGateway(fetch: typeof globalThis.fetch): LLMGateway {
  const provider = createOpenAICompatibleLLMProvider({
    id: "compat-fixture",
    baseURL: "http://127.0.0.1:4321/v1",
    fetch,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

describe("OpenAI-compatible compatibility matrix", () => {
  it("routes a real OpenAI-shaped SSE response through the adapter", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-fixture",
          model: model.model,
          delta: { role: "assistant", content: "fixture ok" },
        }),
        openAIChunk({
          id: "chatcmpl-fixture",
          model: model.model,
          delta: {},
          finishReason: "stop",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Say fixture ok." }],
    });

    expect(result).toMatchObject({
      text: "fixture ok",
      toolCalls: [],
      finishReason: "STOP",
    });
  });

  it("completes fragmented tool arguments only after the final fragment", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-fragment",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-fragment",
                name: "read_file",
                arguments: '{"pa',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-fragment",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, arguments: 'th":' })] },
        }),
        openAIChunk({
          id: "chatcmpl-fragment",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, arguments: '"src/index.ts"}' })] },
        }),
        finishChunk({ id: "chatcmpl-fragment", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const events = [];
    for await (const event of gateway.stream({
      model,
      messages: [{ role: "user", content: "Read the file." }],
      tools: [readFileTool],
    }).events) {
      events.push(event);
    }

    const completed = events.filter((event) => event.type === "tool_call.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: "tool_call.completed",
      payload: { id: "call-fragment", name: "read_file", input: { path: "src/index.ts" } },
    });
  });

  it("does not complete a parsable tool argument prefix", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-prefix",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-prefix",
                name: "read_file",
                arguments: '{"a":1',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-prefix",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, arguments: ',"b":2}' })] },
        }),
        finishChunk({ id: "chatcmpl-prefix", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const events = [];
    for await (const event of gateway.stream({
      model,
      messages: [{ role: "user", content: "Use the tool." }],
      tools: [readFileTool],
    }).events) {
      events.push(event);
    }

    const completed = events.filter((event) => event.type === "tool_call.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      payload: { id: "call-prefix", name: "read_file", input: { a: 1, b: 2 } },
    });
  });

  it("buffers a tool call until a late function name arrives", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-late-name",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({ index: 0, id: "call-late-name", arguments: '{"path":"src/' }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-late-name",
          model: model.model,
          delta: {
            tool_calls: [toolCallDelta({ index: 0, name: "read_file", arguments: 'index.ts"}' })],
          },
        }),
        finishChunk({ id: "chatcmpl-late-name", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const events = [];
    for await (const event of gateway.stream({
      model,
      messages: [{ role: "user", content: "Use the tool." }],
      tools: [readFileTool],
    }).events) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool_call.start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_call.completed")).toEqual([
      {
        type: "tool_call.completed",
        payload: { id: "call-late-name", name: "read_file", input: { path: "src/index.ts" } },
      },
    ]);
  });

  it("accepts a non-zero starting tool-call index", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-index-one",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-index-one",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        finishChunk({ id: "chatcmpl-index-one", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a." }],
      tools: [readFileTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-index-one", name: "read_file", input: { path: "a" } },
    ]);
  });

  it("accepts non-contiguous tool-call indexes without cross-contamination", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-index-gap",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-gap-a",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-index-gap",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 3,
                id: "call-gap-b",
                name: "search_text",
                arguments: '{"query":"b"}',
              }),
            ],
          },
        }),
        finishChunk({ id: "chatcmpl-index-gap", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a and search b." }],
      tools: [readFileTool, searchTextTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-gap-a", name: "read_file", input: { path: "a" } },
      { id: "call-gap-b", name: "search_text", input: { query: "b" } },
    ]);
  });

  it("accepts reused indexes when stable IDs identify independent calls", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-index-reused",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-reused-a",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-index-reused",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-reused-b",
                name: "search_text",
                arguments: '{"query":"b"}',
              }),
            ],
          },
        }),
        finishChunk({
          id: "chatcmpl-index-reused",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a and search b." }],
      tools: [readFileTool, searchTextTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-reused-a", name: "read_file", input: { path: "a" } },
      { id: "call-reused-b", name: "search_text", input: { query: "b" } },
    ]);
  });

  it("accepts a missing index when the stable ID is sufficient", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-index-missing",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                id: "call-index-missing",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        finishChunk({
          id: "chatcmpl-index-missing",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a." }],
      tools: [readFileTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-index-missing", name: "read_file", input: { path: "a" } },
    ]);
  });

  it("keeps out-of-order index calls in completed-event arrival order", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-index-order",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 3,
                id: "call-order-three",
                name: "search_text",
                arguments: '{"query":"three"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-index-order",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-order-one",
                name: "read_file",
                arguments: '{"path":"one"}',
              }),
            ],
          },
        }),
        finishChunk({ id: "chatcmpl-index-order", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Search three and read one." }],
      tools: [readFileTool, searchTextTool],
    });

    expect(result.toolCalls.map((call) => call.id)).toEqual(["call-order-three", "call-order-one"]);
  });

  it("accepts an empty tool-call ID on a continuation", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-empty-id",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-empty-id",
                name: "read_file",
                arguments: '{"path":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-empty-id",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, id: "", arguments: 'a"}' })] },
        }),
        finishChunk({ id: "chatcmpl-empty-id", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a." }],
      tools: [readFileTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-empty-id", name: "read_file", input: { path: "a" } },
    ]);
  });

  it("fails closed for a whitespace tool-call ID continuation", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-whitespace-id",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-whitespace-id",
                name: "read_file",
                arguments: '{"path":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-whitespace-id",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, id: "   ", arguments: 'a"}' })] },
        }),
        finishChunk({
          id: "chatcmpl-whitespace-id",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    await expect(
      gateway.complete({
        model,
        messages: [{ role: "user", content: "Read a." }],
        tools: [readFileTool],
      }),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });

  it("fails closed when the first tool-call ID is missing", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-missing-id",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [toolCallDelta({ index: 0, name: "read_file", arguments: '{"path":"a"}' })],
          },
        }),
        finishChunk({ id: "chatcmpl-missing-id", model: model.model, finishReason: "tool_calls" }),
      ]),
    );

    await expect(
      gateway.complete({
        model,
        messages: [{ role: "user", content: "Read a." }],
        tools: [readFileTool],
      }),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });

  it("fails closed instead of merging distinct calls with the same ID", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-duplicate-id",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-same",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-duplicate-id",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-same",
                name: "search_text",
                arguments: '{"query":"b"}',
              }),
            ],
          },
        }),
        finishChunk({
          id: "chatcmpl-duplicate-id",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    await expect(
      gateway.complete({
        model,
        messages: [{ role: "user", content: "Read a and search b." }],
        tools: [readFileTool, searchTextTool],
      }),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });

  it("fails closed for a delta with neither ID nor index while calls are open", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-ambiguous-delta",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-ambiguous-a",
                name: "read_file",
                arguments: '{"path":"a"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-ambiguous-delta",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-ambiguous-b",
                name: "search_text",
                arguments: '{"query":"b"}',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-ambiguous-delta",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ arguments: "" })] },
        }),
        finishChunk({
          id: "chatcmpl-ambiguous-delta",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    await expect(
      gateway.complete({
        model,
        messages: [{ role: "user", content: "Read a and search b." }],
        tools: [readFileTool, searchTextTool],
      }),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });
});
