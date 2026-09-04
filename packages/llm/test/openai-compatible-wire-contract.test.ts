import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
  type LLMRequest,
} from "../src/index.js";
import { normalizeWireRequest } from "./support/wire-trace.js";
import { finishChunk, openAIChunk, sseResponse } from "./support/openai-compatible-sse.js";

const model = { provider: "deepseek", model: "fixture-model" } as const;
const toolNames = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
] as const;

function requestWithAllNineTools(): LLMRequest {
  return {
    model,
    messages: [
      { role: "system", content: "You are a safe coding agent." },
      { role: "user", content: "Inspect the workspace." },
    ],
    tools: toolNames.map((name): ToolDefinition => ({
      name,
      description: `Use ${name} when needed.`,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", description: "A bounded value." } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: { kind: "local" },
    })),
    toolChoice: { type: "AUTO" },
  };
}

describe("OpenAI-compatible wire tool contract", () => {
  it("captures model-facing tools from the final adapter request without secrets", async () => {
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

    await new LLMGateway({ providers }).complete(requestWithAllNineTools(), {
      signal: new AbortController().signal,
    });

    const trace = normalizeWireRequest(bodies[0]);
    expect(trace.toolNames).toEqual([...toolNames]);
    expect(trace.toolCount).toBe(9);
    expect(new Set(trace.schemaHashes).size).toBe(9);
    expect(trace.roleSequence).toEqual(["system", "user"]);
    expect(trace.toolChoice).toBe("auto");
    expect(trace).not.toHaveProperty("headers");
    expect(trace).not.toHaveProperty("authorization");
    expect(trace).not.toHaveProperty("messages.0.content");
    expect(trace.schemaHashes).toMatchInlineSnapshot(`
      [
        "ec0fa36e75e153f2da4ab4d2a09741f8dcaa58dbd7443da5c713e333498f1744",
        "0330f7f7dfbebd3b94698c7cf9cd82ef9ba7573c29e66d04330643725aee0a64",
        "2e71f81e711e5e059068fe6bc4a048349d7e001393eb3c1f1d636bdf593fa7d9",
        "314a109189160a03539eaa71d1aa984702989efcc5c3ff1779704e16e534bddd",
        "c9c4231b10888e45796f424276b054880c295e33c9c014aabd5e39aaf0b4e093",
        "7ac7b865ced6bdc0921308789b403b23b7853bfaa39437bb108e2e56b71ca187",
        "3a8524f8709c4c489f40f084c575fd66f460f6835056fd348fa53b84eea1c594",
        "c52e9d7f8cbbc072eeb06050cb0b611eeb7775a7a017db28e9ea2ff4349a1e0c",
        "237d83e8b5530768622d4494ea6b3fc1da442e5529c38db9818e7070a292320e",
      ]
    `);
    expect(JSON.stringify(trace)).not.toContain("do-not-store-this-value");
  });
});
