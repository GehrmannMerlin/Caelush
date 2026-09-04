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
          "inputSchemaHash": "6298abe3535dc0cb28511e4967844343b152c0be596ad37f92de2ad91cb60472",
          "name": "read_file",
          "schemaHash": "c1fd6f87c35fe8c204d96f527d1534c7ac48067ebfce9c2a73b3fa86b80519f8",
        },
        {
          "inputSchemaHash": "e08dcb27f8da6a489e6e43b55b84ecd1b4be9eaeb8a0ac1848eb79f1384aca8a",
          "name": "list_directory",
          "schemaHash": "9743d8476efb344b59ceee97fa66955f5c97bc9f996a63f2ad9e9322f914580b",
        },
        {
          "inputSchemaHash": "0206409b11c76c65c56ebf6256a2f1fe89783f0a0df0b39c5b31d38911947737",
          "name": "find_files",
          "schemaHash": "2327b558bbfe823bb0666dc5f1b3a45213a8f439dc0e871301d9e2d21b986771",
        },
        {
          "inputSchemaHash": "61132edd78985cce00d3dfe3bfc619223eecda9a6d2a351f05c6b5aee81e8454",
          "name": "search_text",
          "schemaHash": "e231a19e3a194696db60827b37ca67c9d34e83ea8785fe0b8682d5d11b3d644d",
        },
        {
          "inputSchemaHash": "127aa1f8deb5a8d83a7136d796e5cd2394714a38414ff84e27b7a6f5bac0cae5",
          "name": "apply_patch",
          "schemaHash": "2f3d9a9c445c4c963008ca81174961ef3d368f8723ebb372599c8dfad812a443",
        },
        {
          "inputSchemaHash": "190054a99d7edfec916fc286f550dc02f608ff6791a270711b2dde6912e01676",
          "name": "exec_command",
          "schemaHash": "6fadd3d4fc3c25025fa7d87b24fedc01a19b672ac5a34b88aae43033771bc499",
        },
        {
          "inputSchemaHash": "e40f7ef0f9ed414d9c0d2fdf0ba5e9d1eaaaeffef78b23eca6f5e700f2ffa178",
          "name": "write_stdin",
          "schemaHash": "bc0e0b53277a300598054db65df1d36cc49d4ece9a446121183f78d849f93a9d",
        },
        {
          "inputSchemaHash": "6c38620bea73877101f0297a6d168529a62e481f8c894d3ac8db9e94f3a16686",
          "name": "git_status",
          "schemaHash": "2efb02e7f565d75dce624dba1139f86a027619d954fcbf35fe8b16bb3dc97e41",
        },
        {
          "inputSchemaHash": "22b741d923b4bb98a5d5a7773b26addba0f56b61fcf2189364cdb4aec7a2c8af",
          "name": "git_diff",
          "schemaHash": "fdff498887941ae1663d450e618133c06ceaf597664d4bd91d8ad31676cae3a4",
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
