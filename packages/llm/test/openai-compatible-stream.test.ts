import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
} from "../src/index.js";

const model = { provider: "local-openai", model: "demo-model" };
const dangerousTool: ToolDefinition = {
  name: "dangerous_test_tool",
  description: "A tool that must never execute in the provider adapter.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: { type: "object" },
  riskLevel: "HIGH",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
};

function createSSEResponse(chunks: readonly Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("data: [DONE]\n\n");
  return new Response(encoder.encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createGateway(fetch: typeof globalThis.fetch) {
  const provider = createOpenAICompatibleLLMProvider({
    id: "local-openai",
    baseURL: "http://127.0.0.1:4321/v1",
    fetch,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

describe("OpenAI-compatible stream adapter", () => {
  it("completes one plain-text provider turn through the Gateway", async () => {
    const requests: Request[] = [];
    const gateway = createGateway(async (input, init) => {
      requests.push(new Request(input, init));
      return createSSEResponse([
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [
            { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
          ],
        },
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      ]);
    });

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Say hello." }],
    });

    expect(result).toMatchObject({
      providerId: "local-openai",
      model,
      text: "Hello world",
      toolCalls: [],
      finishReason: "STOP",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(requests).toHaveLength(1);
    const plainRequest = requests[0];
    if (plainRequest === undefined) throw new Error("The test fetch did not receive a request.");
    expect(plainRequest.url).toBe("http://127.0.0.1:4321/v1/chat/completions");
    expect(plainRequest.method).toBe("POST");
  });

  it("normalizes one streamed tool call without executing it", async () => {
    const requests: Request[] = [];
    const gateway = createGateway(async (input, init) => {
      requests.push(new Request(input, init));
      return createSSEResponse([
        {
          id: "chatcmpl-tool-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-dangerous",
                    type: "function",
                    function: { name: "dangerous_test_tool", arguments: '{"path":"/tmp/' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-tool-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'example"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-tool-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "demo-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });

    const stream = gateway.stream({
      model,
      messages: [{ role: "user", content: "Use the tool." }],
      tools: [dangerousTool],
    });
    const events = [];
    for await (const event of stream.events) events.push(event);
    const completed = events.find((event) => event.type === "tool_call.completed");

    expect(completed).toEqual({
      type: "tool_call.completed",
      payload: {
        id: "call-dangerous",
        name: "dangerous_test_tool",
        input: { path: "/tmp/example" },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "stream.start",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.delta",
      "tool_call.completed",
      "stream.finish",
    ]);
    expect(requests).toHaveLength(1);
    const toolRequest = requests[0];
    if (toolRequest === undefined) throw new Error("The test fetch did not receive a request.");
    const requestBody = (await toolRequest.json()) as {
      tools?: Array<{
        type: string;
        function: {
          name: string;
          description: string;
          parameters: { type: string; properties: unknown };
        };
      }>;
    };
    expect(requestBody.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: "dangerous_test_tool",
        description: "A tool that must never execute in the provider adapter.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });
  });
});
