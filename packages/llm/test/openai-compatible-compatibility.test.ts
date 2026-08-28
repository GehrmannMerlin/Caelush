import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
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
});
