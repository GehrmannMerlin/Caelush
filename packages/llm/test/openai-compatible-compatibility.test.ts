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
  usageChunk,
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
const parameterlessTool: ToolDefinition = {
  name: "get_test_value",
  description: "Return a test value.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: [],
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

  it.each([
    ["empty arguments", ""],
    ["empty object arguments", "{}"],
  ] as const)("normalizes a parameterless tool with %s", async (_label, argumentsValue) => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-parameterless",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-parameterless",
                name: "get_test_value",
                arguments: argumentsValue,
              }),
            ],
          },
        }),
        finishChunk({
          id: "chatcmpl-parameterless",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Get the test value." }],
      tools: [parameterlessTool],
    });

    expect(result.toolCalls).toEqual([
      { id: "call-parameterless", name: "get_test_value", input: {} },
    ]);
  });

  it("isolates interleaved parallel calls with different names", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-parallel-different",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-parallel-read",
                name: "read_file",
                arguments: '{"path":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-different",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-parallel-search",
                name: "search_text",
                arguments: '{"query":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-different",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, arguments: 'a"}' })] },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-different",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 1, arguments: 'b"}' })] },
        }),
        finishChunk({
          id: "chatcmpl-parallel-different",
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
      { id: "call-parallel-read", name: "read_file", input: { path: "a" } },
      { id: "call-parallel-search", name: "search_text", input: { query: "b" } },
    ]);
  });

  it("isolates interleaved parallel calls with the same name by ID", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-parallel-same",
          model: model.model,
          delta: {
            role: "assistant",
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-same-a",
                name: "read_file",
                arguments: '{"path":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-same",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 1,
                id: "call-same-b",
                name: "read_file",
                arguments: '{"path":"',
              }),
            ],
          },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-same",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 1, arguments: 'b"}' })] },
        }),
        openAIChunk({
          id: "chatcmpl-parallel-same",
          model: model.model,
          delta: { tool_calls: [toolCallDelta({ index: 0, arguments: 'a"}' })] },
        }),
        finishChunk({
          id: "chatcmpl-parallel-same",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a and b." }],
      tools: [readFileTool],
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        { id: "call-same-a", name: "read_file", input: { path: "a" } },
        { id: "call-same-b", name: "read_file", input: { path: "b" } },
      ]),
    );
  });

  it("preserves a single ToolCallId across two provider turns", async () => {
    const requests: Request[] = [];
    let requestCount = 0;
    const gateway = createGateway(async (input, init) => {
      requests.push(new Request(input, init));
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          openAIChunk({
            id: "chatcmpl-roundtrip-one",
            model: model.model,
            delta: {
              role: "assistant",
              tool_calls: [
                toolCallDelta({
                  index: 0,
                  id: "call-roundtrip-one",
                  name: "read_file",
                  arguments: '{"path":"a"}',
                }),
              ],
            },
          }),
          finishChunk({
            id: "chatcmpl-roundtrip-one",
            model: model.model,
            finishReason: "tool_calls",
          }),
        ]);
      }
      return sseResponse([
        openAIChunk({
          id: "chatcmpl-roundtrip-two",
          model: model.model,
          delta: { role: "assistant", content: "done" },
        }),
        finishChunk({ id: "chatcmpl-roundtrip-two", model: model.model, finishReason: "stop" }),
      ]);
    });

    const first = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a." }],
      tools: [readFileTool],
    });
    const firstCall = first.toolCalls[0];
    if (firstCall === undefined) throw new Error("Turn 1 did not return a tool call.");

    await gateway.complete({
      model,
      messages: [
        { role: "user", content: "Read a." },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: firstCall.id,
              toolName: firstCall.name,
              input: firstCall.input,
            },
          ],
        },
        {
          role: "tool",
          toolCallId: firstCall.id,
          toolName: firstCall.name,
          content: "contents of a",
          isError: false,
        },
        { role: "user", content: "Summarize it." },
      ],
      tools: [readFileTool],
    });

    const secondRequest = requests[1];
    if (secondRequest === undefined) throw new Error("Turn 2 did not reach the provider.");
    const secondBody = (await secondRequest.json()) as {
      messages?: Array<Record<string, unknown>>;
    };
    const toolMessage = secondBody.messages?.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: firstCall.id });
  });

  it("preserves parallel ToolCallIds with their own results across turns", async () => {
    const requests: Request[] = [];
    let requestCount = 0;
    const gateway = createGateway(async (input, init) => {
      requests.push(new Request(input, init));
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          openAIChunk({
            id: "chatcmpl-roundtrip-parallel-one",
            model: model.model,
            delta: {
              role: "assistant",
              tool_calls: [
                toolCallDelta({
                  index: 0,
                  id: "call-roundtrip-a",
                  name: "read_file",
                  arguments: '{"path":"a"}',
                }),
              ],
            },
          }),
          openAIChunk({
            id: "chatcmpl-roundtrip-parallel-one",
            model: model.model,
            delta: {
              tool_calls: [
                toolCallDelta({
                  index: 1,
                  id: "call-roundtrip-b",
                  name: "search_text",
                  arguments: '{"query":"b"}',
                }),
              ],
            },
          }),
          finishChunk({
            id: "chatcmpl-roundtrip-parallel-one",
            model: model.model,
            finishReason: "tool_calls",
          }),
        ]);
      }
      return sseResponse([
        openAIChunk({
          id: "chatcmpl-roundtrip-parallel-two",
          model: model.model,
          delta: { role: "assistant", content: "done" },
        }),
        finishChunk({
          id: "chatcmpl-roundtrip-parallel-two",
          model: model.model,
          finishReason: "stop",
        }),
      ]);
    });

    const first = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a and search b." }],
      tools: [readFileTool, searchTextTool],
    });
    expect(first.toolCalls).toHaveLength(2);

    await gateway.complete({
      model,
      messages: [
        { role: "user", content: "Read a and search b." },
        {
          role: "assistant",
          content: first.toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })),
        },
        {
          role: "tool",
          toolCallId: "call-roundtrip-b",
          toolName: "search_text",
          content: "found b",
          isError: false,
        },
        {
          role: "tool",
          toolCallId: "call-roundtrip-a",
          toolName: "read_file",
          content: "contents of a",
          isError: false,
        },
        { role: "user", content: "Summarize both." },
      ],
      tools: [readFileTool, searchTextTool],
    });

    const secondRequest = requests[1];
    if (secondRequest === undefined) throw new Error("Turn 2 did not reach the provider.");
    const secondBody = (await secondRequest.json()) as {
      messages?: Array<Record<string, unknown>>;
    };
    const toolMessages = secondBody.messages?.filter((message) => message.role === "tool");
    expect(toolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_call_id: "call-roundtrip-a", content: "contents of a" }),
        expect.objectContaining({ tool_call_id: "call-roundtrip-b", content: "found b" }),
      ]),
    );
  });

  it("does not expose provider reasoning content as public text", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-reasoning-tool",
          model: model.model,
          delta: { role: "assistant", reasoning_content: "private reasoning" },
        }),
        openAIChunk({
          id: "chatcmpl-reasoning-tool",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-reasoning-tool",
                name: "read_file",
                arguments: '{"path":"README.md"}',
              }),
            ],
          },
        }),
        finishChunk({
          id: "chatcmpl-reasoning-tool",
          model: model.model,
          finishReason: "tool_calls",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read the README." }],
      tools: [readFileTool],
    });

    expect(result.text).toBe("");
    expect(result.text).not.toContain("private reasoning");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-reasoning-tool",
        name: "read_file",
        input: { path: "README.md" },
      }),
    ]);
  });

  it("preserves usage and finish reason from an OpenAI-compatible stream", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-usage-finish",
          model: model.model,
          delta: {
            tool_calls: [
              toolCallDelta({
                index: 0,
                id: "call-usage-a",
                name: "read_file",
                arguments: '{"path":"a.txt"}',
              }),
              toolCallDelta({
                index: 1,
                id: "call-usage-b",
                name: "search_text",
                arguments: '{"query":"b"}',
              }),
            ],
          },
        }),
        usageChunk({
          id: "chatcmpl-usage-finish",
          model: model.model,
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }),
        finishChunk({
          id: "chatcmpl-usage-finish",
          model: model.model,
          finishReason: "tool_calls",
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Read a and search b." }],
      tools: [readFileTool, searchTextTool],
    });

    expect(result.finishReason).toBe("TOOL_CALLS");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(result.toolCalls).toHaveLength(2);
  });

  it("does not leak malformed upstream payloads or secrets", async () => {
    const secret = "CAELUSH_TEST_SECRET_DO_NOT_LEAK_42";
    const gateway = createGateway(
      async () =>
        new Response(`data: malformed ${secret}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    let caught: unknown;
    try {
      await gateway.complete({ model, messages: [{ role: "user", content: "hello" }] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LLMInvalidResponseError);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});
