import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  finishChunk,
  openAIChunk,
  sseResponse,
  type CapturingTransport,
} from "../../support/openai-compatible-transport.js";
import { singleModelSource } from "../../support/gateway-fixtures.js";
import type { AIModelRequest } from "../../../src/request/model-request.js";
import type { AIToolSpec } from "../../../src/tools/tool-spec.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";
import type { AISubsystem } from "../../../src/create-ai-subsystem.js";

const ENDPOINT = "http://127.0.0.1:4321/v1";
const API_ID = "openai-compatible-chat";

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

/** A successful text turn. */
function textTurnResponse(text = "ok"): Response {
  return sseResponse([
    openAIChunk({
      id: "chatcmpl-golden",
      model: "fixture-model",
      delta: { role: "assistant", content: text },
    }),
    finishChunk({ id: "chatcmpl-golden", model: "fixture-model", finishReason: "stop" }),
  ]);
}

interface Harness {
  readonly ai: AISubsystem;
  readonly transport: CapturingTransport;
  /** The single captured provider request body. */
  body(): Record<string, unknown>;
  url(): string;
}

function harness(
  options: {
    readonly descriptor?: ModelDescriptor;
    readonly endpoint?: string;
    readonly credentials?: ProviderCredentials;
    readonly headers?: Readonly<Record<string, string>>;
    readonly queryParams?: Readonly<Record<string, string>>;
    readonly transport?: CapturingTransport;
  } = {},
): Harness {
  const transport = options.transport ?? capturingTransport(() => textTurnResponse());
  const descriptor =
    options.descriptor ??
    modelDescriptor({ ref: { provider: "compat-fixture", model: "fixture-model" }, api: API_ID });

  const ai = createAISubsystem({
    modelSources: [singleModelSource(descriptor, "golden")],
    providers: [
      {
        id: descriptor.ref.provider,
        endpoint: options.endpoint ?? ENDPOINT,
        defaultApi: API_ID,
        allowUnknownModels: false,
        credentials: {
          resolve: () => Promise.resolve(options.credentials ?? { apiKey: "fixture-key" }),
        },
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.queryParams === undefined ? {} : { queryParams: options.queryParams }),
        transport: { fetch: transport.fetch },
      },
    ],
    adapters: [createOpenAICompatibleApiAdapter()],
  });

  return {
    ai,
    transport,
    body: () => {
      const request = transport.requests[0];
      if (request === undefined) throw new Error("no provider request was captured");
      return request.body;
    },
    url: () => {
      const request = transport.requests[0];
      if (request === undefined) throw new Error("no provider request was captured");
      return request.url;
    },
  };
}

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "compat-fixture", model: "fixture-model" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

describe("OpenAI-compatible request golden: messages", () => {
  it("sends a single user message", async () => {
    const h = harness();
    await h.ai.gateway.complete(request());

    expect(h.body()).toEqual({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("sends system messages as one leading system message, not as user content", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({
        messages: [
          { role: "system", content: "you are caelush" },
          { role: "system", content: "be concise" },
          { role: "user", content: "hello" },
        ],
      }),
    );

    // Several system messages join with a blank line and keep caller order. This is
    // the long-standing behaviour of the dialect and is deliberately unchanged.
    expect(h.body()["messages"]).toEqual([
      { role: "system", content: "you are caelush\n\nbe concise" },
      { role: "user", content: "hello" },
    ]);
  });

  it("sends an assistant text message", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: "again" },
        ],
      }),
    );

    expect(h.body()["messages"]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
  });

  it("sends an assistant tool call with its matching result", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "read_file",
                input: { path: "a.ts" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "read_file",
            content: "body",
            isError: false,
          },
        ],
      }),
    );

    const messages = h.body()["messages"] as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "calling",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    });
  });

  it("sends each tool result as a tool message carrying its own content", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "read_file",
                input: { path: "a.ts" },
              },
              {
                type: "tool-call",
                toolCallId: "c2",
                toolName: "read_file",
                input: { path: "b.ts" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "read_file",
            content: "body",
            isError: false,
          },
          {
            role: "tool",
            toolCallId: "c2",
            toolName: "read_file",
            content: "missing",
            isError: true,
          },
        ],
      }),
    );

    // The dialect has no tool-result error flag, so a failed result is carried as
    // its error text and stays distinguishable from the successful one. The
    // success/error distinction itself lives in the adapter's output variants.
    expect(h.body()["messages"]).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "body" },
      { role: "tool", tool_call_id: "c2", content: "missing" },
    ]);
  });

  it("preserves multi-turn order and never reorders messages", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: [{ type: "text", text: "two" }] },
          { role: "user", content: "three" },
          { role: "assistant", content: [{ type: "text", text: "four" }] },
          { role: "user", content: "five" },
        ],
      }),
    );

    const messages = h.body()["messages"] as { content: unknown }[];
    expect(messages.map((message) => JSON.stringify(message.content))).toEqual([
      '"one"',
      '"two"',
      '"three"',
      '"four"',
      '"five"',
    ]);
  });
});

describe("OpenAI-compatible request golden: tools", () => {
  it("sends only name, description and parameters under a function envelope", async () => {
    const h = harness();
    await h.ai.gateway.complete(request({ tools: [READ_FILE] }));

    const tools = h.body()["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });
    // No tool metadata may reach the provider request.
    const serialized = JSON.stringify(tools);
    for (const forbidden of [
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "outputSchema",
      "approvalPolicy",
      "handler",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("preserves declaration order instead of sorting", async () => {
    const h = harness();
    await h.ai.gateway.complete(request({ tools: [SEARCH_TEXT, READ_FILE] }));

    const tools = h.body()["tools"] as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).toEqual(["search_text", "read_file"]);
  });

  it("maps every frozen tool choice", async () => {
    const cases = [
      [{ type: "AUTO" } as const, "auto"],
      [{ type: "NONE" } as const, "none"],
      [{ type: "REQUIRED" } as const, "required"],
    ] as const;

    for (const [toolChoice, native] of cases) {
      const h = harness();
      await h.ai.gateway.complete(request({ tools: [READ_FILE], toolChoice }));
      expect(h.body()["tool_choice"], toolChoice.type).toBe(native);
    }

    const pinned = harness();
    await pinned.ai.gateway.complete(
      request({ tools: [READ_FILE], toolChoice: { type: "TOOL", toolName: "read_file" } }),
    );
    expect(pinned.body()["tool_choice"]).toEqual({
      type: "function",
      function: { name: "read_file" },
    });
  });

  it("sends no tools when none are declared", async () => {
    const h = harness();
    await h.ai.gateway.complete(request());

    expect(h.body()).not.toHaveProperty("tools");
    expect(h.body()).not.toHaveProperty("tool_choice");
  });
});

describe("OpenAI-compatible request golden: settings", () => {
  it("sends temperature and maxOutputTokens", async () => {
    const h = harness();
    await h.ai.gateway.complete(request({ settings: { temperature: 0.25, maxOutputTokens: 512 } }));

    expect(h.body()["temperature"]).toBe(0.25);
    expect(h.body()["max_tokens"]).toBe(512);
  });

  it("omits settings that were not requested", async () => {
    const h = harness();
    await h.ai.gateway.complete(request());

    expect(h.body()).not.toHaveProperty("temperature");
    // The model limit validates a requested ceiling; it is never sent as an implicit
    // cap, because that would silently truncate a caller who asked for no limit.
    expect(h.body()).not.toHaveProperty("max_tokens");
  });

  it("translates an effective reasoning level to the native effort", async () => {
    const h = harness({
      descriptor: modelDescriptor({
        ref: { provider: "compat-fixture", model: "fixture-model" },
        api: API_ID,
        reasoning: { supportedLevels: ["LOW", "MEDIUM", "HIGH"], supportsSummary: "UNKNOWN" },
      }),
    });
    await h.ai.gateway.complete(request({ settings: { reasoning: { level: "HIGH" } } }));

    expect(h.body()["reasoning_effort"]).toBe("high");
  });

  it("sends no reasoning field when nothing was requested", async () => {
    const h = harness();
    await h.ai.gateway.complete(request());

    expect(h.body()).not.toHaveProperty("reasoning_effort");
  });

  it("sends no cache field, because this dialect has no cache control", async () => {
    const h = harness();
    await h.ai.gateway.complete(
      request({ settings: { cache: { retention: "LONG", key: "conv-1" } } }),
    );

    // The resolver downgraded LONG to NONE because the descriptor claims no cache
    // support, so nothing cache-related reaches the provider.
    const serialized = JSON.stringify(h.body());
    expect(serialized).not.toContain("cache");
    expect(serialized).not.toContain("conv-1");
  });
});

describe("OpenAI-compatible request golden: stability and authority", () => {
  it("produces an identical body for an identical request", async () => {
    const first = harness();
    const second = harness();

    const shared: AIModelRequest = request({
      tools: [SEARCH_TEXT, READ_FILE],
      settings: { temperature: 0.5 },
    });
    await first.ai.gateway.complete(shared);
    await second.ai.gateway.complete(shared);

    expect(JSON.stringify(first.body())).toBe(JSON.stringify(second.body()));
  });

  it("keeps a stable system-and-tools prefix across consecutive turns", async () => {
    const h = harness();
    const base: AIModelRequest = request({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
      ],
      tools: [SEARCH_TEXT, READ_FILE],
    });

    await h.ai.gateway.complete(base);
    const firstPrefix = JSON.stringify({
      messages: h.body()["messages"],
      tools: h.body()["tools"],
    });

    await h.ai.gateway.complete({
      ...base,
      messages: [...base.messages, { role: "assistant", content: [{ type: "text", text: "two" }] }],
    });
    const secondPrefix = JSON.stringify({
      messages: (h.body()["messages"] as unknown[]).slice(0, 2),
      tools: h.body()["tools"],
    });

    expect(secondPrefix).toBe(firstPrefix);
  });

  it("uses the provider endpoint, never a legacy ModelRef.baseUrl", async () => {
    const h = harness({ endpoint: "http://expected.example/v1" });
    await h.ai.gateway.complete({
      ...request(),
      model: {
        provider: "compat-fixture",
        model: "fixture-model",
        baseUrl: "http://attacker.example/v1",
      },
    });

    expect(h.url()).toContain("expected.example");
    expect(h.url()).not.toContain("attacker.example");
  });

  it("sends the resolved credentials, headers and query parameters", async () => {
    const h = harness({
      credentials: {
        apiKey: "fixture-key",
        headers: { "x-credential": "from-secret" },
        queryParams: { "api-version": "2024-01-01" },
      },
      headers: { "x-tenant": "acme" },
      queryParams: { trace: "on" },
    });
    await h.ai.gateway.complete(request());

    const captured = h.transport.requests[0];
    expect(captured?.headers["authorization"]).toBe("Bearer fixture-key");
    expect(captured?.headers["x-tenant"]).toBe("acme");
    expect(captured?.headers["x-credential"]).toBe("from-secret");
    expect(h.url()).toContain("api-version=2024-01-01");
    expect(h.url()).toContain("trace=on");
  });
});
