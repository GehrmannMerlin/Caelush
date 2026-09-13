import { describe, expect, it } from "vitest";
import { captureTurn, expectFailClosed } from "./support/harness.js";
import {
  ANTHROPIC_MESSAGES_API_ID,
  createAnthropicMessagesApiAdapter,
} from "../../../src/adapters/anthropic-messages/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import { capturingTransport, textTurnEvents } from "../../support/anthropic-messages-transport.js";
import type { AIModelRequest } from "../../../src/request/model-request.js";
import type { AIToolSpec } from "../../../src/tools/tool-spec.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";

const API_ID = ANTHROPIC_MESSAGES_API_ID;

const READ_FILE: AIToolSpec = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

const SEARCH_TEXT: AIToolSpec = {
  name: "search_text",
  description: "Search text.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

/** A descriptor that declares native thinking capability through adapter metadata. */
const THINKING_METADATA = {
  anthropicMessages: {
    thinking: {
      supported: true,
      defaultEnabled: false,
      disableSupported: true,
      display: "summarized",
      budgetTokensByLevel: { LOW: 2_048, MEDIUM: 8_192, HIGH: 16_384 },
      effortByLevel: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
    },
  },
};

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "anthropic-fixture", model: "fixture-model" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

describe("Anthropic Messages request golden: messages", () => {
  it("sends a single user message as a text content block", async () => {
    const turn = await captureTurn(request());

    expect(turn.body).toEqual({
      model: "fixture-model",
      max_tokens: 8_000,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("hoists leading system messages into a top-level system field, in order", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "system", content: "first instruction" },
          { role: "system", content: "second instruction" },
          { role: "user", content: "hello" },
        ],
      }),
    );

    expect(turn.body["system"]).toEqual([
      { type: "text", text: "first instruction" },
      { type: "text", text: "second instruction" },
    ]);
    expect(turn.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("never emits a system role inside messages", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "system", content: "instructions" },
          { role: "user", content: "hello" },
        ],
      }),
    );

    const messages = turn.body["messages"] as readonly { role: string }[];
    expect(messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("fails closed on a system message after the conversation started", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
          { role: "system", content: "late instruction" },
          { role: "user", content: "again" },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
  });

  it("keeps assistant text in caller order", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
          { role: "user", content: "again" },
        ],
      }),
    );

    expect(turn.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
  });

  it("maps an assistant tool call onto tool_use", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "reading" },
              {
                type: "tool-call",
                toolCallId: "toolu_a",
                toolName: "read_file",
                input: { path: "a.ts" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "read_file",
            content: "contents",
            isError: false,
          },
        ],
      }),
    );

    expect(turn.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "contents", is_error: false },
        ],
      },
    ]);
  });
  it("maps an error tool result onto is_error true", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "read_file",
            content: "boom",
            isError: true,
          },
        ],
      }),
    );

    const messages = turn.body["messages"] as readonly { content: readonly unknown[] }[];
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: "boom", is_error: true },
    ]);
  });
  it("preserves parallel tool result order exactly as the caller sent it", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "read both" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_b", toolName: "search_text", input: {} },
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_b",
            toolName: "search_text",
            content: "second-declared first-answered",
            isError: false,
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "read_file",
            content: "first-declared second-answered",
            isError: false,
          },
        ],
      }),
    );

    const messages = turn.body["messages"] as readonly {
      readonly content: readonly {
        readonly type: string;
        readonly id?: string;
        readonly tool_use_id?: string;
      }[];
    }[];
    // Assistant batch order is toolu_b then toolu_a.
    expect(messages[1]?.content.map((block) => block.id)).toEqual(["toolu_b", "toolu_a"]);
    // The answers keep the caller's order, which is deliberately the opposite of the
    // batch order, and they merge into the single native user message a parallel
    // batch requires.
    expect(messages).toHaveLength(3);
    expect(messages[2]?.content.map((block) => block.tool_use_id)).toEqual(["toolu_b", "toolu_a"]);
  });
});

describe("Anthropic Messages request golden: tool protocol validation", () => {
  it("fails closed on a tool result referencing an unknown tool_use", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "tool",
            toolCallId: "toolu_x",
            toolName: "read_file",
            content: "x",
            isError: false,
          },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed on a duplicate tool_use id", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
              { type: "tool-call", toolCallId: "toolu_a", toolName: "search_text", input: {} },
            ],
          },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed on a duplicate tool result", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "read_file",
            content: "1",
            isError: false,
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "read_file",
            content: "2",
            isError: false,
          },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed when a tool result names a different tool than its tool call", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_a",
            toolName: "search_text",
            content: "x",
            isError: false,
          },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
  });

  it("fails closed when a tool call continues without its required result", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
          { role: "user", content: "never mind" },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed when the conversation ends with an unresolved tool call", async () => {
    const turn = await captureTurn(
      request({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "toolu_a", toolName: "read_file", input: {} },
            ],
          },
        ],
      }),
    );

    expectFailClosed(turn, "AI_INVALID_REQUEST");
  });
});

describe("Anthropic Messages request golden: tools and tool choice", () => {
  it("translates tools to name, description and input_schema only", async () => {
    const turn = await captureTurn(
      request({ tools: [READ_FILE, SEARCH_TEXT], toolChoice: { type: "AUTO" } }),
    );

    expect(turn.body["tools"]).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "search_text",
        description: "Search text.",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });
  it.each([
    ["AUTO", { type: "auto" }],
    ["NONE", { type: "none" }],
    ["REQUIRED", { type: "any" }],
  ] as const)("maps the %s tool choice", async (choiceType, expected) => {
    const turn = await captureTurn(
      request({
        tools: [READ_FILE],
        toolChoice: { type: choiceType },
      }),
    );

    expect(turn.body["tool_choice"]).toEqual(expected);
  });

  it("maps the TOOL tool choice by name", async () => {
    const turn = await captureTurn(
      request({ tools: [READ_FILE], toolChoice: { type: "TOOL", toolName: "read_file" } }),
    );

    expect(turn.body["tool_choice"]).toEqual({ type: "tool", name: "read_file" });
  });

  it("sends no tools and no tool choice when none are declared", async () => {
    const turn = await captureTurn(request());

    expect(turn.body).not.toHaveProperty("tools");
    expect(turn.body).not.toHaveProperty("tool_choice");
  });

  it("keeps Caelush tool metadata out of the native request", async () => {
    const turn = await captureTurn(request({ tools: [READ_FILE], toolChoice: { type: "AUTO" } }));

    const serialized = JSON.stringify(turn.body);
    for (const forbidden of [
      "riskLevel",
      "outputSchema",
      "requiredCapabilities",
      "runtimeRequirements",
      "approval",
      "verification",
      "handler",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("Anthropic Messages request golden: settings", () => {
  it("sends temperature when the caller set one", async () => {
    const turn = await captureTurn(request({ settings: { temperature: 0.25 } }));

    expect(turn.body["temperature"]).toBe(0.25);
  });

  it("omits temperature when the caller did not set one", async () => {
    const turn = await captureTurn(request());

    expect(turn.body).not.toHaveProperty("temperature");
  });

  it("uses the caller's maxOutputTokens as max_tokens", async () => {
    const turn = await captureTurn(request({ settings: { maxOutputTokens: 512 } }));

    expect(turn.body["max_tokens"]).toBe(512);
  });

  it("falls back to the descriptor limit and never invents a number", async () => {
    const turn = await captureTurn(request(), {
      descriptor: modelDescriptor({
        ref: { provider: "anthropic-fixture", model: "fixture-model" },
        api: API_ID,
        limits: { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
      }),
    });

    expect(turn.body["max_tokens"]).toBe(64_000);
  });
});

describe("Anthropic Messages request golden: transport and endpoint", () => {
  it("appends the canonical Messages path to a root endpoint", async () => {
    const turn = await captureTurn(request());

    expect(turn.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("treats a trailing slash root as a root", async () => {
    const turn = await captureTurn(request(), { endpoint: "https://api.anthropic.com/" });

    expect(turn.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("fails closed on a prefixed Messages path without explicit metadata", async () => {
    // `/anthropic/v1/messages` is readable by a human but not unambiguously
    // derivable from the endpoint alone, so it is configuration, not a guess.
    const turn = await captureTurn(request(), {
      endpoint: "https://proxy.example/anthropic/v1/messages",
    });

    expectFailClosed(turn, "AI_INVALID_REQUEST");
  });

  it("fails closed on an ambiguous non-root endpoint without metadata", async () => {
    const turn = await captureTurn(request(), { endpoint: "https://proxy.example/anthropic" });

    expectFailClosed(turn, "AI_INVALID_REQUEST");
    expect(turn.transportAttempts).toBe(0);
  });

  it("uses an explicit messagesPath for a non-standard proxy endpoint", async () => {
    const turn = await captureTurn(request(), {
      endpoint: "https://proxy.example/gateway",
      compatibility: { anthropicMessages: { messagesPath: "/custom/messages" } },
    });

    expect(turn.url).toBe("https://proxy.example/custom/messages");
  });

  it("preserves endpoint query parameters and adds configured ones", async () => {
    const turn = await captureTurn(request(), {
      endpoint: "https://proxy.example",
      queryParams: { "api-version": "2024-01-01" },
    });

    expect(turn.url).toBe("https://proxy.example/v1/messages?api-version=2024-01-01");
  });

  it("uses the provider endpoint and never the legacy model baseUrl", async () => {
    const turn = await captureTurn(
      request({
        model: {
          provider: "anthropic-fixture",
          model: "fixture-model",
          baseUrl: "http://attacker.example/v1",
        },
      }),
    );

    expect(turn.url).toBe("https://api.anthropic.com/v1/messages");
    expect(turn.url).not.toContain("attacker.example");
  });

  it("posts a JSON body with the frozen stream flag", async () => {
    const turn = await captureTurn(request());

    expect(turn.request.method).toBe("POST");
    expect(turn.request.headers["content-type"]).toBe("application/json");
    expect(turn.body["stream"]).toBe(true);
  });
});

describe("Anthropic Messages request golden: headers and authentication", () => {
  it("sends the default anthropic-version", async () => {
    const turn = await captureTurn(request());

    expect(turn.request.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("honours an explicitly configured anthropic-version", async () => {
    const turn = await captureTurn(request(), {
      headers: { "anthropic-version": "2024-10-22" },
    });

    expect(turn.request.headers["anthropic-version"]).toBe("2024-10-22");
  });

  it("sends the API key as x-api-key", async () => {
    const turn = await captureTurn(request());

    expect(turn.request.headers["x-api-key"]).toBe("fixture-key");
    expect(turn.request.headers).not.toHaveProperty("authorization");
  });

  it("sends a bearer token only when metadata explicitly asks for bearer mode", async () => {
    const turn = await captureTurn(request(), {
      credentials: { bearerToken: "fixture-bearer" },
      compatibility: { anthropicMessages: { authMode: "bearer" } },
    });

    expect(turn.request.headers["authorization"]).toBe("Bearer fixture-bearer");
    expect(turn.request.headers).not.toHaveProperty("x-api-key");
  });

  it("treats a lone bearer token as unambiguous even without explicit metadata", async () => {
    const turn = await captureTurn(request(), {
      credentials: { bearerToken: "fixture-bearer" },
    });

    expect(turn.request.headers["authorization"]).toBe("Bearer fixture-bearer");
  });

  it("fails closed when both credentials exist without an explicit auth mode", async () => {
    const turn = await captureTurn(request(), {
      credentials: { apiKey: "fixture-key", bearerToken: "fixture-bearer" },
    });

    expectFailClosed(turn, "AI_AUTHENTICATION");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed when the declared auth mode has no matching credential", async () => {
    const turn = await captureTurn(request(), {
      credentials: { apiKey: "fixture-key" },
      compatibility: { anthropicMessages: { authMode: "bearer" } },
    });

    expectFailClosed(turn, "AI_AUTHENTICATION");
    expect(turn.transportAttempts).toBe(0);
  });

  it("sends configured static and credential headers", async () => {
    const turn = await captureTurn(request(), {
      headers: { "x-tenant": "tenant-a" },
      credentials: { apiKey: "fixture-key", headers: { "x-trace": "trace-1" } },
    });

    expect(turn.request.headers["x-tenant"]).toBe("tenant-a");
    expect(turn.request.headers["x-trace"]).toBe("trace-1");
  });

  it("keeps the API key out of the request body and out of every public event", async () => {
    const turn = await captureTurn(request());

    expect(JSON.stringify(turn.body)).not.toContain("fixture-key");
    expect(JSON.stringify(turn.events)).not.toContain("fixture-key");
  });
});

describe("Anthropic Messages request golden: cache", () => {
  function cacheDescriptor(): ModelDescriptor {
    return modelDescriptor({
      ref: { provider: "anthropic-fixture", model: "fixture-model" },
      api: API_ID,
      cache: { supportedRetentions: ["NONE", "SHORT", "LONG"] },
    });
  }

  it("sends no cache control for retention NONE", async () => {
    const turn = await captureTurn(request({ settings: { cache: { retention: "NONE" } } }), {
      descriptor: cacheDescriptor(),
    });

    expect(JSON.stringify(turn.body)).not.toContain("cache_control");
  });

  it("maps SHORT onto an ephemeral 5m marker", async () => {
    const turn = await captureTurn(request({ settings: { cache: { retention: "SHORT" } } }), {
      descriptor: cacheDescriptor(),
    });

    const messages = turn.body["messages"] as readonly {
      readonly content: readonly Record<string, unknown>[];
    }[];
    expect(messages.at(-1)?.content.at(-1)?.["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("maps LONG onto an ephemeral 1h marker", async () => {
    const turn = await captureTurn(request({ settings: { cache: { retention: "LONG" } } }), {
      descriptor: cacheDescriptor(),
    });

    const messages = turn.body["messages"] as readonly {
      readonly content: readonly Record<string, unknown>[];
    }[];
    expect(messages.at(-1)?.content.at(-1)?.["cache_control"]).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("marks the last tool when there is no content block to mark", async () => {
    const turn = await captureTurn(
      request({
        messages: [{ role: "system", content: "only system" }],
        tools: [READ_FILE],
        settings: { cache: { retention: "SHORT" } },
      }),
      { descriptor: cacheDescriptor() },
    );

    expect(turn.body["tools"]).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
  it("never leaks the semantic cache key into the native request", async () => {
    const turn = await captureTurn(
      request({ settings: { cache: { retention: "SHORT", key: "semantic-cache-key" } } }),
      { descriptor: cacheDescriptor() },
    );

    const serialized = JSON.stringify(turn.body);
    expect(serialized).not.toContain("semantic-cache-key");
    expect(serialized).not.toContain('"key"');
  });

  it("does not change prompt content when caching is requested", async () => {
    const withoutCache = await captureTurn(request(), { descriptor: cacheDescriptor() });
    const withCache = await captureTurn(request({ settings: { cache: { retention: "SHORT" } } }), {
      descriptor: cacheDescriptor(),
    });

    const strip = (body: Record<string, unknown>): string =>
      JSON.stringify(body)
        .replaceAll('"cache_control":{"type":"ephemeral"},', "")
        .replaceAll(',"cache_control":{"type":"ephemeral"}', "");

    expect(strip(withCache.body)).toBe(strip(withoutCache.body));
  });
});

describe("Anthropic Messages request golden: reasoning", () => {
  function thinkingDescriptor(): ModelDescriptor {
    return modelDescriptor({
      ref: { provider: "anthropic-fixture", model: "fixture-model" },
      api: API_ID,
      reasoning: {
        supportedLevels: ["OFF", "LOW", "MEDIUM", "HIGH"],
        supportsSummary: "SUPPORTED",
      },
      adapterMetadata: THINKING_METADATA,
    });
  }

  it("translates a text-only reasoning level into native thinking and effort", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: thinkingDescriptor(),
    });

    expect(turn.body["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 16_384,
      display: "summarized",
    });
    expect(turn.body["output_config"]).toEqual({ effort: "high" });
  });

  it("fails closed when tools are combined with a non-OFF reasoning level", async () => {
    const turn = await captureTurn(
      request({
        tools: [READ_FILE],
        toolChoice: { type: "AUTO" },
        settings: { reasoning: { level: "HIGH" } },
      }),
      { descriptor: thinkingDescriptor() },
    );

    expectFailClosed(turn, "AI_CAPABILITY_UNSUPPORTED");
    expect(turn.transportAttempts).toBe(0);
  });

  it("fails closed when the metadata maps no native budget for the level", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "XHIGH" } } }), {
      descriptor: modelDescriptor({
        ref: { provider: "anthropic-fixture", model: "fixture-model" },
        api: API_ID,
        reasoning: {
          supportedLevels: ["OFF", "LOW", "HIGH", "XHIGH"],
          supportsSummary: "SUPPORTED",
        },
        adapterMetadata: THINKING_METADATA,
      }),
    });

    expectFailClosed(turn, "AI_CAPABILITY_UNSUPPORTED");
  });

  it("never inspects the model name to decide thinking", async () => {
    // A descriptor whose model id mentions no vendor at all still gets native
    // thinking, and a vendor-looking id without metadata does not.
    const withMetadata = await captureTurn(
      request({
        model: { provider: "anthropic-fixture", model: "opaque-1" },
        settings: { reasoning: { level: "LOW" } },
      }),
      {
        descriptor: modelDescriptor({
          ref: { provider: "anthropic-fixture", model: "opaque-1" },
          api: API_ID,
          reasoning: { supportedLevels: ["OFF", "LOW"], supportsSummary: "SUPPORTED" },
          adapterMetadata: THINKING_METADATA,
        }),
      },
    );
    expect((withMetadata.body["thinking"] as { type: string }).type).toBe("enabled");

    const withoutMetadata = await captureTurn(
      request({
        model: { provider: "anthropic-fixture", model: "claude-opus-5" },
        settings: { reasoning: { level: "LOW" } },
      }),
      {
        descriptor: modelDescriptor({
          ref: { provider: "anthropic-fixture", model: "claude-opus-5" },
          api: API_ID,
          reasoning: { supportedLevels: ["OFF", "LOW"], supportsSummary: "SUPPORTED" },
        }),
      },
    );
    expectFailClosed(withoutMetadata, "AI_CAPABILITY_UNSUPPORTED");
  });
});

describe("Anthropic Messages request golden: frozen dialect identity", () => {
  it("declares exactly the reserved api id", () => {
    expect(createAnthropicMessagesApiAdapter().id).toBe("anthropic-messages");
    expect(API_ID).toBe("anthropic-messages");
  });

  it("depends on no provider SDK", async () => {
    const turn = await captureTurn(request());

    expect(turn.transportAttempts).toBe(1);
    expect(turn.request.url).toContain("api.anthropic.com");
  });

  it("supports the capturing transport fixture contract", () => {
    const transport = capturingTransport(() => new Response("", { status: 500 }));
    expect(transport.callCount()).toBe(0);
    expect(textTurnEvents("x").length).toBeGreaterThan(0);
  });
});

describe("Anthropic Messages request golden: credential isolation fixture", () => {
  it("accepts an explicit credential resolver result without echoing it", async () => {
    const secret = "fixture-secret-value";
    const credentials: ProviderCredentials = { apiKey: secret };
    const turn = await captureTurn(request(), { credentials });

    expect(turn.request.headers["x-api-key"]).toBe(secret);
    expect(JSON.stringify(turn.events)).not.toContain(secret);
  });
});
