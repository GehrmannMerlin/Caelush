import { describe, expect, it } from "vitest";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import {
  createDefaultBuiltinToolRegistrations,
  DEFAULT_BUILTIN_TOOL_ORDER,
  ToolRegistryBuilder,
} from "@caelush/tools";
import { assertSafeWireRequestBody, normalizeWireRequest } from "./support/wire-trace.js";
import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
  type LLMRequest,
} from "@caelush/llm";
import { finishChunk, openAIChunk, sseResponse } from "./support/openai-compatible-sse.js";

const model = { provider: "deepseek", model: "fixture-model" } as const;

function canonicalToolDefinitions() {
  const runtime = new LocalRuntime();
  const registrations = createDefaultBuiltinToolRegistrations(createLocalRuntimeResolver(runtime));
  const builder = new ToolRegistryBuilder();
  for (const registration of registrations) builder.register(registration);
  return { definitions: builder.build().modelDefinitions(), runtime };
}

function requestWithCanonicalTools(): LLMRequest {
  const { definitions } = canonicalToolDefinitions();
  return {
    model,
    messages: [
      { role: "system", content: "You are a safe coding agent." },
      { role: "user", content: "Inspect the workspace." },
    ],
    tools: [...definitions],
    toolChoice: { type: "AUTO" },
  };
}

describe("OpenAI-compatible wire tool contract", () => {
  it("captures the canonical model-facing tools from the final adapter request safely", async () => {
    const bodies: unknown[] = [];
    const provider = createOpenAICompatibleLLMProvider({
      id: "deepseek",
      baseURL: "https://provider.invalid/v1",
      apiKey: "do-not-store-this-value",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return sseResponse([
          openAIChunk({
            id: "chatcmpl-wire-contract",
            model: model.model,
            delta: { role: "assistant", content: "ok" },
          }),
          finishChunk({ id: "chatcmpl-wire-contract", model: model.model, finishReason: "stop" }),
        ]);
      },
    });
    const providers = new LLMProviderRegistry();
    providers.register(provider);

    await new LLMGateway({ providers }).complete(requestWithCanonicalTools(), {
      signal: new AbortController().signal,
    });

    const body = bodies[0];
    expect(() => assertSafeWireRequestBody(body)).not.toThrow();
    const trace = normalizeWireRequest(body);
    expect(trace.model).toBe("fixture-model");
    expect(trace.toolNames).toEqual([...DEFAULT_BUILTIN_TOOL_ORDER]);
    expect(trace.toolCount).toBe(9);
    expect(trace.roleSequence).toEqual(["system", "user"]);
    expect(trace.roleCounts).toEqual({ system: 1, user: 1 });
    expect(trace.metadata).toEqual({ messageCount: 2, toolCount: 9, hasTools: true });
    expect(Object.keys(trace.metadata)).toEqual(["messageCount", "toolCount", "hasTools"]);
    expect(trace.metadata.messageCount).toBeGreaterThanOrEqual(1);
    expect(trace.metadata.messageCount).toBeLessThanOrEqual(128);
    expect(trace.metadata.toolCount).toBe(9);
    expect(trace.metadata.hasTools).toBe(true);
    expect(trace.toolChoice).toBe("auto");
    expect(new Set(trace.inputSchemaHashes).size).toBe(9);
    expect(new Set(trace.schemaHashes).size).toBe(9);
    expect(trace.schemaMatrix).toMatchInlineSnapshot(`
      [
        {
          "inputSchemaHash": "e0e2ea148c97826d5c9ec75e5a2b97a85e6ab90e7d6de6bba70c143587eb1362",
          "name": "read_file",
          "schemaHash": "493e768ac4795b076ecedbd09f73e1f8d4254801bc1f1fcaa835399eb607e1c6",
        },
        {
          "inputSchemaHash": "7660439b3e7a8529dece2f98702bcbd82315a5649727e1698b6145c79d18de90",
          "name": "list_directory",
          "schemaHash": "21683fe5a44d7f8f425d217b6dc583401406f1ee65b8f0ff98545789cdca755d",
        },
        {
          "inputSchemaHash": "ecfc94aa8995a3306d54a9853f508de11d859164648ac2916827cd2b4e46769b",
          "name": "find_files",
          "schemaHash": "d3a9dded0da2b6dd441ea0c67bc062d428542bc573bbe02cbf55e453a0889eec",
        },
        {
          "inputSchemaHash": "ad77d96e0a1e24ff1a893fe65d9192839e96f5db77079475ba1c18925b1bf3cc",
          "name": "search_text",
          "schemaHash": "1b86a0b2c98b2a1a5525133feab0b2422c6a908d7bbd2c85a66ff30ada42ff7a",
        },
        {
          "inputSchemaHash": "127aa1f8deb5a8d83a7136d796e5cd2394714a38414ff84e27b7a6f5bac0cae5",
          "name": "apply_patch",
          "schemaHash": "ab508e56f57d28256a7985d420e63fa3b8303db6b7950a80d7b70332acc1e8a8",
        },
        {
          "inputSchemaHash": "66f7ca301faa8b4999e5a4e55aae3f75fe5ce6433dfcdc89b4fce0e176666fcc",
          "name": "exec_command",
          "schemaHash": "d86636594873ca5464f773af1e79e161fdbb999ea9b8e65af74088b22c08f316",
        },
        {
          "inputSchemaHash": "0ee0ff81044b6828de9de3cb8427b23003d2951f3bdc3f9cb0538a36f77d0295",
          "name": "write_stdin",
          "schemaHash": "a01b64b8c129642b03beb10f77fe016ae97f0c160fca81cb6c9af88862f4eb76",
        },
        {
          "inputSchemaHash": "b9da1384ec88c9de6bf953d77a2b11cab146c499daf9ca0a6cd7c959bcf5e046",
          "name": "git_status",
          "schemaHash": "3cf0764c9151055004c37e776d696b4499516264e12be17cfe6c8019ebbc17df",
        },
        {
          "inputSchemaHash": "b40395c21919afb294b7789b18d9218128f686a6aa39c4308c27019d65a57e99",
          "name": "git_diff",
          "schemaHash": "314bff5fa5f261a5641d6af1e35a6a6a875b715894e111eb0c6b94dcfad19aee",
        },
      ]
    `);
    expect(trace).not.toHaveProperty("headers");
    expect(trace).not.toHaveProperty("authorization");
    expect(trace).not.toHaveProperty("messages");
    expect(JSON.stringify(trace)).not.toContain("do-not-store-this-value");
    expect(JSON.stringify(trace)).not.toContain("Inspect the workspace.");
    expect(JSON.stringify(trace)).not.toContain("Reads a UTF-8 text file");
  });

  it("rejects forbidden or unexpected raw wire structure without exposing values", () => {
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              execute: "forbidden",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        headers: { authorization: "forbidden" },
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        tool_choice: { type: "function", function: { name: "read_file" }, extra: true },
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: Array.from({ length: 129 }, () => ({ role: "user", content: "bounded" })),
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        temperature: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        max_tokens: 0,
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "",
        messages: [],
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "",
              description: "Read a file.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertSafeWireRequestBody({
        model: "fixture-model",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
      }),
    ).toThrow();
  });
});
