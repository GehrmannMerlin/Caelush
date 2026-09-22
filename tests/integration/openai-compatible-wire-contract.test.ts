import { describe, expect, it } from "vitest";
import { createAISubsystem } from "@caelush/ai";
import { createOpenAICompatibleApiAdapter } from "@caelush/ai/adapters/openai-compatible";
import { DefaultAgentToolRegistryBuilder, type AgentToolRegistry } from "@caelush/agent";
import {
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  DEFAULT_CODING_TOOL_ORDER,
  type DefaultCodingToolOperations,
} from "@caelush/coding-agent";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { assertSafeWireRequestBody, normalizeWireRequest } from "./support/wire-trace.js";
import { finishChunk, openAIChunk, sseResponse } from "./support/openai-compatible-sse.js";
import type { AIModelRequest, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";

/**
 * The final OpenAI-compatible wire contract.
 *
 * Phase 2D cut this test over from the retired `@caelush/llm` gateway to the frozen AI
 * core, so it now drives the same production chain the daemon does:
 *
 * ```text
 * AIGateway.complete() → createOpenAICompatibleApiAdapter() → fetch
 * ```
 *
 * The Tool catalog it sends is the production one: the nine Coding Tools, built through the four
 * Runtime Operations adapters, the canonical `DefaultAgentToolRegistryBuilder`, and read back in the
 * registry's own model-facing form. Phase 4F retired Protocol's `ToolDefinition` and Core's
 * `toAIToolSpec` projection — `AgentToolRegistry.modelSpecs()` *is* `readonly AIToolSpec[]` — so there
 * is no longer a second shape for a catalog to be projected through.
 */

const model = { provider: "deepseek", model: "fixture-model" } as const;
const API_ID = "openai-compatible-chat";

/** The four Runtime Operations adapters, as the one bundle `createDefaultCodingTools` expects. */
function codingToolOperations(runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>) {
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  return {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(runtimeResolver),
    exec: createRuntimeProcessOperations(runtimeResolver),
    process: createRuntimeProcessOperations(runtimeResolver),
    git: createRuntimeGitOperations(runtimeResolver),
  } satisfies DefaultCodingToolOperations;
}

function canonicalToolRegistry(): { registry: AgentToolRegistry; runtime: LocalRuntime } {
  const runtime = new LocalRuntime();
  const builder = new DefaultAgentToolRegistryBuilder();
  const definitions = createDefaultCodingTools(
    codingToolOperations(createLocalRuntimeResolver(runtime)),
  );
  for (const definition of definitions) builder.register(definition.tool);
  return { registry: builder.build(), runtime };
}

function requestWithCanonicalTools(): AIModelRequest {
  const { registry } = canonicalToolRegistry();
  return {
    model,
    messages: [
      { role: "system", content: "You are a safe coding agent." },
      { role: "user", content: "Inspect the workspace." },
    ],
    tools: registry.modelSpecs(),
    toolChoice: { type: "AUTO" },
  };
}

/** The fixture model metadata authority, expressed on the frozen AI contract. */
function descriptorSource(): ModelDescriptorSourcePort & {
  list(): readonly import("@caelush/ai").ModelDescriptor[];
} {
  const descriptor = {
    ref: { provider: model.provider, model: model.model },
    api: API_ID,
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    capabilities: {
      streaming: "SUPPORTED" as const,
      toolCalling: "SUPPORTED" as const,
      parallelToolCalls: "SUPPORTED" as const,
      structuredOutput: "UNKNOWN" as const,
      vision: "UNKNOWN" as const,
      reasoning: "UNKNOWN" as const,
      reasoningSummary: "UNKNOWN" as const,
      promptCaching: "UNKNOWN" as const,
      usageReporting: "UNKNOWN" as const,
    },
    source: "CONFIGURATION" as const,
  };

  return {
    id: "wire-contract-fixture",
    priority: 0,
    resolve: (ref) =>
      ref.provider === model.provider && ref.model === model.model ? descriptor : undefined,
    list: () => [descriptor],
  };
}

describe("OpenAI-compatible wire tool contract", () => {
  it("captures the canonical model-facing tools from the final adapter request safely", async () => {
    const bodies: unknown[] = [];
    const ai = createAISubsystem({
      modelSources: [descriptorSource()],
      providers: [
        {
          id: model.provider,
          endpoint: "https://provider.invalid/v1",
          defaultApi: API_ID,
          allowUnknownModels: false,
          credentials: { resolve: async () => ({ apiKey: "do-not-store-this-value" }) },
          transport: {
            fetch: (async (_input: unknown, init?: RequestInit) => {
              bodies.push(JSON.parse(String(init?.body)) as unknown);
              return sseResponse([
                openAIChunk({
                  id: "chatcmpl-wire-contract",
                  model: model.model,
                  delta: { role: "assistant", content: "ok" },
                }),
                finishChunk({
                  id: "chatcmpl-wire-contract",
                  model: model.model,
                  finishReason: "stop",
                }),
              ]);
            }) as unknown as typeof globalThis.fetch,
          },
        },
      ],
      adapters: [createOpenAICompatibleApiAdapter() as ApiAdapter],
    });

    await ai.gateway.complete(requestWithCanonicalTools(), {
      signal: new AbortController().signal,
    });

    const body = bodies[0];
    expect(() => assertSafeWireRequestBody(body)).not.toThrow();
    const trace = normalizeWireRequest(body);
    expect(trace.model).toBe("fixture-model");
    expect(trace.toolNames).toEqual([...DEFAULT_CODING_TOOL_ORDER]);
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
          "schemaHash": "50da2f1470e0795cf5c5155552a26168878cc1477cefc845d3d21a9ee6043585",
        },
        {
          "inputSchemaHash": "7660439b3e7a8529dece2f98702bcbd82315a5649727e1698b6145c79d18de90",
          "name": "list_directory",
          "schemaHash": "43212e606ca9b7cbb91028a0c157b8fee19bce53393b3194dfab2b780f236f85",
        },
        {
          "inputSchemaHash": "ecfc94aa8995a3306d54a9853f508de11d859164648ac2916827cd2b4e46769b",
          "name": "find_files",
          "schemaHash": "2f0196038ea2f3d195ec298c092a9f8d4aaa7c14928cacfb3d63cee80798c96e",
        },
        {
          "inputSchemaHash": "ad77d96e0a1e24ff1a893fe65d9192839e96f5db77079475ba1c18925b1bf3cc",
          "name": "search_text",
          "schemaHash": "55891a5b0acfcdc71c30cd2e08fff4ccae5692802882e4eb0f8b2c1bfd53f007",
        },
        {
          "inputSchemaHash": "127aa1f8deb5a8d83a7136d796e5cd2394714a38414ff84e27b7a6f5bac0cae5",
          "name": "apply_patch",
          "schemaHash": "a1831faf8f448560247f9e02bc66eb5a0ce7724128bbf190357fe30bdec03072",
        },
        {
          "inputSchemaHash": "66f7ca301faa8b4999e5a4e55aae3f75fe5ce6433dfcdc89b4fce0e176666fcc",
          "name": "exec_command",
          "schemaHash": "dc9750f8787e6dd8a586733332389d2ad2138c756db48b8648836f6273445422",
        },
        {
          "inputSchemaHash": "0ee0ff81044b6828de9de3cb8427b23003d2951f3bdc3f9cb0538a36f77d0295",
          "name": "write_stdin",
          "schemaHash": "2830460db2cfed5a1bef5cb01323024b443c28c56102ccac61734e5a11df00cc",
        },
        {
          "inputSchemaHash": "b9da1384ec88c9de6bf953d77a2b11cab146c499daf9ca0a6cd7c959bcf5e046",
          "name": "git_status",
          "schemaHash": "ac0ef37e2d135d12ac4d1d2b0bcbeb9a46d8f5a9b55ce9f9465f39a9a5bcd1a2",
        },
        {
          "inputSchemaHash": "b40395c21919afb294b7789b18d9218128f686a6aa39c4308c27019d65a57e99",
          "name": "git_diff",
          "schemaHash": "a3b921c3d1ca57d803c5eaf9ce175d01cc2cbf1b710f59111f5ce128e64e623e",
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
