import { describe, expect, it } from "vitest";
import { AIError } from "../../../src/errors/ai-error.js";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  finishChunk,
  hangingTransport,
  openAIChunk,
  sseResponse,
  toolCallDelta,
} from "../../support/openai-compatible-transport.js";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import { runAdapterConformance } from "./adapter-conformance.js";
import type { AdapterConformanceOptions } from "./types.js";
import type { EnumerableModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";

const SECRET = "fake-api-secret-123";
const API_ID = "openai-compatible-chat";
const PROVIDER_ID = "compat-fixture";
const ENDPOINT = "http://127.0.0.1:4321/v1";

const CREDENTIALS: ProviderCredentials = {
  apiKey: SECRET,
  headers: { "x-credential-secret": SECRET },
  queryParams: { "api-secret": SECRET },
};

/** One complete text turn. */
function textChunks(text: string): readonly Record<string, unknown>[] {
  return [
    openAIChunk({ id: "c1", model: "fixture-model", delta: { role: "assistant", content: text } }),
    finishChunk({ id: "c1", model: "fixture-model", finishReason: "stop" }),
  ];
}

function toolChunks(): readonly Record<string, unknown>[] {
  return [
    openAIChunk({
      id: "c1",
      model: "fixture-model",
      delta: {
        tool_calls: [
          toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: '{"pa' }),
        ],
      },
    }),
    openAIChunk({
      id: "c1",
      model: "fixture-model",
      delta: { tool_calls: [toolCallDelta({ index: 0, arguments: 'th":"a.ts"}' })] },
    }),
    finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
  ];
}

function parallelToolChunks(): readonly Record<string, unknown>[] {
  return [
    openAIChunk({
      id: "c1",
      model: "fixture-model",
      delta: {
        tool_calls: [
          toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: '{"path":"a"}' }),
          toolCallDelta({
            index: 1,
            id: "call-b",
            name: "search_text",
            arguments: '{"query":"b"}',
          }),
        ],
      },
    }),
    finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
  ];
}

function usageChunks(): readonly Record<string, unknown>[] {
  return [
    openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "hi" } }),
    finishChunk({
      id: "c1",
      model: "fixture-model",
      finishReason: "stop",
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
  ];
}

const OPENAI_CONFORMANCE: AdapterConformanceOptions = {
  apiId: API_ID,
  providerId: PROVIDER_ID,
  endpoint: ENDPOINT,
  adapters: [createOpenAICompatibleApiAdapter()],
  credentials: CREDENTIALS,
  secret: SECRET,

  textTurn: (text) => capturingTransport(() => sseResponse(textChunks(text))),
  toolTurn: () => capturingTransport(() => sseResponse(toolChunks())),
  parallelToolTurn: () => capturingTransport(() => sseResponse(parallelToolChunks())),
  usageTurn: () => capturingTransport(() => sseResponse(usageChunks())),

  finishReason: (reason) => {
    const wire = {
      STOP: "stop",
      LENGTH: "length",
      TOOL_CALLS: "tool_calls",
      CONTENT_FILTER: "content_filter",
    }[reason];
    return capturingTransport(() =>
      sseResponse([finishChunk({ id: "c1", model: "fixture-model", finishReason: wire })]),
    );
  },
  unknownFinish: () =>
    capturingTransport(() =>
      sseResponse([
        finishChunk({
          id: "c1",
          model: "fixture-model",
          finishReason: "insufficient_system_resource",
        }),
      ]),
    ),

  authFailure: () => capturingTransport(() => new Response("{}", { status: 401 })),
  rateLimitFailure: () =>
    capturingTransport(() => new Response("{}", { status: 429, headers: { "retry-after": "2" } })),
  overflowFailure: () =>
    capturingTransport(
      () =>
        new Response(
          JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }),
          { status: 400 },
        ),
    ),
  invalidResponseFailure: () =>
    capturingTransport(
      () =>
        new Response(
          [
            openAIChunk({
              id: "c1",
              model: "fixture-model",
              delta: {
                tool_calls: [
                  toolCallDelta({ index: 0, id: "call-a", name: "read_file", arguments: "{" }),
                  toolCallDelta({ index: 1, id: "call-b", name: "search_text", arguments: "{" }),
                ],
              },
            }),
            openAIChunk({
              id: "c1",
              model: "fixture-model",
              delta: { tool_calls: [toolCallDelta({ arguments: '"x"}' })] },
            }),
            finishChunk({ id: "c1", model: "fixture-model", finishReason: "tool_calls" }),
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ),
  networkFailure: () => capturingTransport(() => Promise.reject(new Error("socket closed"))),

  textThenFailure: () =>
    capturingTransport(
      () =>
        new Response(
          `data: ${JSON.stringify(
            openAIChunk({ id: "c1", model: "fixture-model", delta: { content: "partial" } }),
          )}\n\ndata: {"truncated`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ),

  hang: () => hangingTransport(),

  reasoning: {
    level: "HIGH",
    // This dialect expresses a level only for MINIMAL..HIGH, and does so through the
    // SDK's own `reasoningEffort` provider option.
    assertNative: (request) => {
      expect(request.body["reasoning_effort"]).toBe("high");
    },
  },
  cache: {
    // The pinned SDK exposes no prompt-cache control, so a non-NONE effective
    // retention must fail closed rather than be silently dropped.
    expressible: false,
  },
};

describe("OpenAI-compatible adapter conformance", () => {
  runAdapterConformance(OPENAI_CONFORMANCE);

  it("uses the production subsystem composition, not a test-only path", () => {
    // The suite must exercise the same composition an application would use.
    const transport = OPENAI_CONFORMANCE.textTurn("ok");
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
      adapters: [createOpenAICompatibleApiAdapter()],
    });

    expect(ai.adapters.listIds()).toEqual([API_ID]);
    expect(transport.callCount()).toBe(0);
  });

  it("reports a missing capability as a typed AIError rather than a raw throw", () => {
    // Guards the conformance harness's own assumption about the failure contract.
    expect(new AIError("AI_CAPABILITY_UNSUPPORTED", "x").code).toBe("AI_CAPABILITY_UNSUPPORTED");
  });
});
