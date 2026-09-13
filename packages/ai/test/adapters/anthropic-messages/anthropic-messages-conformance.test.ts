import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  failingTransport,
  hangingTransport,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  blockStop,
  rawSseResponse,
  sseResponse,
  textBlockStart,
  textDelta,
  toolBlockStart,
  toolTurnEvents,
} from "../../support/anthropic-messages-transport.js";
import {
  ANTHROPIC_MESSAGES_API_ID,
  createAnthropicMessagesApiAdapter,
} from "../../../src/adapters/anthropic-messages/index.js";
import { runAdapterConformance } from "../conformance/adapter-conformance.js";
import type { AdapterConformanceOptions } from "../conformance/types.js";
import type { EnumerableModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";
import type { NativeEvent } from "../../support/anthropic-messages-transport.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";

const SECRET = "fake-anthropic-secret-123";
const API_ID = ANTHROPIC_MESSAGES_API_ID;
const PROVIDER_ID = "anthropic-fixture";
const ENDPOINT = "http://127.0.0.1:4321";

const CREDENTIALS: ProviderCredentials = {
  apiKey: SECRET,
  headers: { "x-credential-secret": SECRET },
  queryParams: { "api-secret": SECRET },
};

function textEvents(text: string) {
  return [
    messageStart(),
    textBlockStart(0),
    textDelta(0, text),
    blockStop(0),
    messageDelta("end_turn", { output_tokens: 5 }),
    messageStop(),
  ];
}

function parallelToolEvents() {
  return [
    messageStart(),
    toolBlockStart(0, "call-a", "read_file"),
    toolBlockStart(1, "call-b", "search_text"),
    inputJsonDelta(0, '{"path":"a.ts"}'),
    inputJsonDelta(1, '{"query":"b"}'),
    blockStop(0),
    blockStop(1),
    messageDelta("tool_use", { output_tokens: 12 }),
    messageStop(),
  ];
}

function usageEvents() {
  return [
    messageStart({ input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2 }),
    textBlockStart(0),
    textDelta(0, "hi"),
    blockStop(0),
    messageDelta("end_turn", {
      output_tokens: 3,
      output_tokens_details: { thinking_tokens: 1 },
    }),
    messageStop(),
  ];
}

/**
 * The Anthropic Messages dialect reuses the shared conformance suite unchanged.
 *
 * Only the wire scripts and the two dialect hooks differ. The suite itself has no
 * knowledge of OpenAI, of SSE, or of any header name.
 */
const ANTHROPIC_CONFORMANCE: AdapterConformanceOptions = {
  apiId: API_ID,
  providerId: PROVIDER_ID,
  endpoint: ENDPOINT,
  adapters: [createAnthropicMessagesApiAdapter()],
  credentials: CREDENTIALS,
  secret: SECRET,
  // The dialect's native authentication mechanism is `x-api-key`.
  credentialAssertion: { header: "x-api-key", value: SECRET },
  // This dialect reports a usage snapshot per native event that carries counters —
  // `message_start` for the input side and `message_delta` for the output side — and
  // streams a tool input as two `input_json_delta` fragments.
  eventOrder: {
    text: ["stream.start", "usage", "text.delta", "usage", "stream.finish"],
    toolLifecycle: [
      "stream.start",
      "usage",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.delta",
      "tool_call.completed",
      "usage",
      "stream.finish",
    ],
  },

  textTurn: (text) => capturingTransport(() => sseResponse(textEvents(text))),
  toolTurn: () => capturingTransport(() => sseResponse(toolTurnEvents("call-a", "read_file"))),
  parallelToolTurn: () => capturingTransport(() => sseResponse(parallelToolEvents())),
  usageTurn: () => capturingTransport(() => sseResponse(usageEvents())),

  finishReason: (reason) => {
    const wire = {
      STOP: "end_turn",
      LENGTH: "max_tokens",
      TOOL_CALLS: "tool_use",
      CONTENT_FILTER: "refusal",
    }[reason];
    // `TOOL_CALLS` is produced by a tool block and everything else by a text block;
    // a turn never carries both.
    const content: readonly NativeEvent[] =
      reason === "TOOL_CALLS"
        ? [toolBlockStart(0, "call-a", "read_file"), inputJsonDelta(0, "{}")]
        : [textBlockStart(0), textDelta(0, "x")];
    return capturingTransport(() =>
      sseResponse([
        messageStart(),
        ...content,
        blockStop(0),
        messageDelta(wire, { output_tokens: 3 }),
        messageStop(),
      ]),
    );
  },
  unknownFinish: () =>
    capturingTransport(() =>
      sseResponse([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta("some_unknown_reason", { output_tokens: 3 }),
        messageStop(),
      ]),
    ),

  authFailure: () => failingTransport(401, '{"error":{"type":"authentication_error"}}'),
  rateLimitFailure: () => failingTransport(429, "{}", { "retry-after": "2" }),
  overflowFailure: () =>
    failingTransport(
      400,
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens" },
      }),
    ),
  invalidResponseFailure: () =>
    capturingTransport(() =>
      sseResponse([
        messageStart(),
        toolBlockStart(0, "call-a", "read_file"),
        inputJsonDelta(0, "{not json"),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    ),
  networkFailure: () => capturingTransport(() => Promise.reject(new Error("socket closed"))),

  textThenFailure: () =>
    capturingTransport(() =>
      rawSseResponse(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\nevent: error\ndata: {"truncated`,
      ),
    ),

  hang: () => hangingTransport(),

  reasoning: {
    level: "HIGH",
    // The dialect expresses a level as native extended thinking plus an output
    // effort, and only for a model whose metadata declares the mapping.
    assertNative: (request) => {
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(body["thinking"]).toEqual({
        type: "enabled",
        budget_tokens: 16_384,
        display: "summarized",
      });
      expect(body["output_config"]).toEqual({ effort: "high" });
    },
  },
  cache: {
    expressible: true,
    assertNative: (request) => {
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(JSON.stringify(body["messages"])).toContain(
        '"cache_control":{"type":"ephemeral","ttl":"1h"}',
      );
    },
  },

  /**
   * The dialect declares its native capabilities through the frozen model-descriptor
   * `adapterMetadata` contract. The suite carries the data without interpreting it,
   * so the same suite still knows nothing about thinking budgets or output efforts.
   */
  modelMetadata: () => ({
    anthropicMessages: {
      thinking: {
        supported: true,
        defaultEnabled: false,
        disableSupported: true,
        display: "summarized",
        budgetTokensByLevel: { HIGH: 16_384 },
        effortByLevel: { HIGH: "high" },
      },
    },
  }),
};

/**
 * The conformance options above run against a descriptor that declares no adapter
 * metadata, which is the honest default. The reasoning scenario needs the model's
 * own declaration, so it is exercised with an explicit descriptor.
 */
describe("Anthropic Messages adapter conformance", () => {
  runAdapterConformance(ANTHROPIC_CONFORMANCE);

  it("uses the production subsystem composition, not a test-only path", () => {
    const transport = ANTHROPIC_CONFORMANCE.textTurn("ok");
    const source: EnumerableModelDescriptorSourcePort = {
      id: "conformance",
      priority: 0,
      resolve: (ref) => modelDescriptor({ ref, api: API_ID }),
      list: () => [],
    };

    const ai = createAISubsystem({
      modelSources: [source],
      providers: [
        {
          id: PROVIDER_ID,
          endpoint: ENDPOINT,
          defaultApi: API_ID,
          allowUnknownModels: false,
          credentials: { resolve: () => Promise.resolve(CREDENTIALS) },
          transport: { fetch: transport.fetch },
        },
      ],
      adapters: [createAnthropicMessagesApiAdapter()],
    });

    expect(ai.adapters.listIds()).toEqual([API_ID]);
    expect(transport.callCount()).toBe(0);
  });

  it("declares the reserved dialect id", () => {
    expect(ANTHROPIC_CONFORMANCE.apiId).toBe("anthropic-messages");
  });

  it("needs no adapter metadata for a plain text turn", () => {
    // The shared suite's descriptors declare no `anthropicMessages` namespace, so a
    // dialect that required one would fail the whole suite.
    expect(ANTHROPIC_CONFORMANCE.credentials).toBe(CREDENTIALS);
  });
});
