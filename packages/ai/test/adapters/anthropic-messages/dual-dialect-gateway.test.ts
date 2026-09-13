import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { createAnthropicMessagesApiAdapter } from "../../../src/adapters/anthropic-messages/index.js";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import { capturingTransport } from "../../support/http-capturing-transport.js";
import {
  capturingTransport as anthropicTransport,
  textTurnEvents,
} from "../../support/anthropic-messages-transport.js";
import {
  capturingTransport as openAITransport,
  finishChunk,
  openAIChunk,
  sseResponse,
} from "../../support/openai-compatible-transport.js";
import type { AIProviderBinding } from "../../../src/providers/provider-binding.js";
import type { AISubsystem } from "../../../src/create-ai-subsystem.js";
import type {
  CapturedHttpRequest,
  CapturingTransport as NeutralTransport,
} from "../../support/http-capturing-transport.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";
import type { ModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";

const OPENAI_API = "openai-compatible-chat";
const ANTHROPIC_API = "anthropic-messages";

const OPENAI_PROVIDER = "openai-provider";
const ANTHROPIC_PROVIDER = "anthropic-provider";
const SHARED_PROVIDER = "shared-provider";

const OPENAI_SECRET = "fake-openai-secret";
const ANTHROPIC_SECRET = "fake-anthropic-secret";

/** The OpenAI-compatible model A. */
const MODEL_A: ModelDescriptor = modelDescriptor({
  ref: { provider: OPENAI_PROVIDER, model: "model-a" },
  api: OPENAI_API,
});

/** The Anthropic Messages model B. */
const MODEL_B: ModelDescriptor = modelDescriptor({
  ref: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
  api: ANTHROPIC_API,
});

/** A catalog that resolves exactly the models the tests declare. */
function catalogSource(descriptors: readonly ModelDescriptor[]): ModelDescriptorSourcePort {
  return {
    id: "dual-dialect-catalog",
    priority: 0,
    resolve: (ref) =>
      descriptors.find(
        (descriptor) =>
          descriptor.ref.provider === ref.provider && descriptor.ref.model === ref.model,
      ),
  };
}

/** An OpenAI-shaped text turn. */
function openAITurn(text: string): Response {
  return sseResponse([
    openAIChunk({
      id: "chatcmpl-dual",
      model: "model-a",
      delta: { role: "assistant", content: text },
    }),
    finishChunk({ id: "chatcmpl-dual", model: "model-a", finishReason: "stop" }),
  ]);
}

interface Harness {
  readonly ai: AISubsystem;
  readonly openAITransport: NeutralTransport;
  readonly anthropicTransport: NeutralTransport;
  readonly openAIAdapter: ReturnType<typeof createOpenAICompatibleApiAdapter>;
  readonly anthropicAdapter: ReturnType<typeof createAnthropicMessagesApiAdapter>;
}

/**
 * One gateway, one provider registry, one adapter registry, two dialects.
 *
 * This is the Phase 2D proof that the frozen AI core is not a paper abstraction:
 * `Model != Provider != API dialect` holds because a descriptor chooses the dialect,
 * the registry resolves it, and nothing in the gateway, the catalog or the provider
 * layer ever inspects a provider name to decide how to talk to a model.
 */
function harness(): Harness {
  const openAITransport = openAITransportCapture();
  const anthropic = anthropicTransport(() => sseResponseFor(textTurnEvents("anthropic answer")));
  const openAIAdapter = createOpenAICompatibleApiAdapter();
  const anthropicAdapter = createAnthropicMessagesApiAdapter();

  const ai = createAISubsystem({
    modelSources: [catalogSource([MODEL_A, MODEL_B])],
    providers: [
      {
        id: OPENAI_PROVIDER,
        endpoint: "http://openai.example/v1",
        defaultApi: OPENAI_API,
        allowUnknownModels: false,
        credentials: { resolve: () => Promise.resolve({ apiKey: OPENAI_SECRET }) },
        transport: { fetch: openAITransport.fetch },
      },
      {
        id: ANTHROPIC_PROVIDER,
        endpoint: "https://api.anthropic.com",
        defaultApi: ANTHROPIC_API,
        allowUnknownModels: false,
        credentials: { resolve: () => Promise.resolve({ apiKey: ANTHROPIC_SECRET }) },
        transport: { fetch: anthropic.fetch },
      },
    ],
    // Both dialects are registered on the same registry, in one subsystem.
    adapters: [openAIAdapter, anthropicAdapter],
  });

  return {
    ai,
    openAITransport,
    anthropicTransport: anthropic,
    openAIAdapter,
    anthropicAdapter,
  };
}

function openAITransportCapture(): NeutralTransport {
  return openAITransport(() => openAITurn("openai answer"));
}

function sseResponseFor(events: readonly { event: string; data: Record<string, unknown> }[]): Response {
  return new Response(
    events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("one gateway serving two native API dialects", () => {
  it("registers both dialects on a single adapter registry", () => {
    const { ai } = harness();

    expect([...ai.adapters.listIds()].sort()).toEqual([ANTHROPIC_API, OPENAI_API]);
  });

  it("dispatches model A to the OpenAI-compatible transport only", async () => {
    const { ai, openAITransport, anthropicTransport: anthropic } = harness();

    const result = await ai.gateway.complete({
      model: { provider: OPENAI_PROVIDER, model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("openai answer");
    expect(result.resolution.api).toBe(OPENAI_API);
    expect(openAITransport.callCount()).toBe(1);
    expect(anthropic.callCount()).toBe(0);
  });

  it("dispatches model B to the Anthropic Messages transport only", async () => {
    const { ai, openAITransport, anthropicTransport: anthropic } = harness();

    const result = await ai.gateway.complete({
      model: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("anthropic answer");
    expect(result.resolution.api).toBe(ANTHROPIC_API);
    expect(anthropic.callCount()).toBe(1);
    expect(openAITransport.callCount()).toBe(0);
  });

  it("drives both dialects from the same gateway instance in one session", async () => {
    const { ai, openAITransport, anthropicTransport: anthropic } = harness();

    const fromA = await ai.gateway.complete({
      model: { provider: OPENAI_PROVIDER, model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });
    const fromB = await ai.gateway.complete({
      model: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fromA.text).toBe("openai answer");
    expect(fromB.text).toBe("anthropic answer");
    expect(openAITransport.callCount()).toBe(1);
    expect(anthropic.callCount()).toBe(1);
  });

  it("selects the dialect from the model descriptor, never from the provider", async () => {
    const { ai } = harness();

    const fromA = await ai.gateway.complete({
      model: { provider: OPENAI_PROVIDER, model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });
    const fromB = await ai.gateway.complete({
      model: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fromA.resolution.api).toBe(MODEL_A.api);
    expect(fromB.resolution.api).toBe(MODEL_B.api);
  });

  it("emits each dialect's own native wire shape on its own transport", async () => {
    const { ai, openAITransport, anthropicTransport: anthropic } = harness();

    await ai.gateway.complete({
      model: { provider: OPENAI_PROVIDER, model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });
    await ai.gateway.complete({
      model: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    const openAIBody = JSON.parse(
      openAITransport.requests[0]?.bodyText ?? "{}",
    ) as Record<string, unknown>;
    const anthropicBody = JSON.parse(
      anthropic.requests[0]?.bodyText ?? "{}",
    ) as Record<string, unknown>;

    // The two dialects share nothing on the wire except the fact that they are JSON.
    expect(openAIBody["messages"]).toEqual([{ role: "user", content: "hello" }]);
    expect(anthropicBody["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(anthropicBody).toHaveProperty("max_tokens");
    expect(anthropic.requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(openAITransport.requests[0]?.url).toContain("/chat/completions");
  });

  it("keeps each dialect's credential on its own transport", async () => {
    const { ai, openAITransport, anthropicTransport: anthropic } = harness();

    await ai.gateway.complete({
      model: { provider: OPENAI_PROVIDER, model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });
    await ai.gateway.complete({
      model: { provider: ANTHROPIC_PROVIDER, model: "model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(JSON.stringify(openAITransport.requests[0]?.headers)).not.toContain(ANTHROPIC_SECRET);
    expect(JSON.stringify(anthropic.requests[0]?.headers)).not.toContain(OPENAI_SECRET);
  });

  it("needs no daemon, agent, storage or runtime to compose two dialects", () => {
    const { ai } = harness();

    // `createAISubsystem` is the whole composition surface: two adapters, two
    // providers, one catalog, one gateway.
    expect(ai.providers.list().map((provider) => provider.defaultApi).sort()).toEqual([
      ANTHROPIC_API,
      OPENAI_API,
    ]);
  });
});

describe("one provider binding, two dialects", () => {
  /**
   * The same provider id and endpoint, two models whose descriptors name different
   * dialects. The dialect is a property of the model, so this must work — and it
   * proves the gateway never keys behaviour off a provider name.
   */
  function sharedProviderHarness(): {
    readonly ai: AISubsystem;
    readonly openAIRequests: CapturedHttpRequest[];
    readonly anthropicRequests: CapturedHttpRequest[];
  } {
    const openAIRequests: CapturedHttpRequest[] = [];
    const anthropicRequests: CapturedHttpRequest[] = [];

    const modelA: ModelDescriptor = modelDescriptor({
      ref: { provider: SHARED_PROVIDER, model: "shared-model-a" },
      api: OPENAI_API,
    });
    const modelB: ModelDescriptor = modelDescriptor({
      ref: { provider: SHARED_PROVIDER, model: "shared-model-b" },
      api: ANTHROPIC_API,
    });

    // One provider, one endpoint, one fetch seam. Which native protocol answers is
    // decided purely by the url the chosen adapter built, so the routing decision is
    // observable without the provider id ever entering the picture.
    const router: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const captured: CapturedHttpRequest = {
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
        bodyText: typeof init?.body === "string" ? init.body : "",
        signalAborted: () => init?.signal?.aborted === true,
        hasSignal: () => init?.signal !== undefined && init?.signal !== null,
      };

      if (url.includes("/v1/messages")) {
        anthropicRequests.push(captured);
        return Promise.resolve(sseResponseFor(textTurnEvents("anthropic answer")));
      }
      openAIRequests.push(captured);
      return Promise.resolve(openAITurn("openai answer"));
    };

    const binding: AIProviderBinding = {
      id: SHARED_PROVIDER,
      endpoint: "https://shared.example",
      defaultApi: OPENAI_API,
      allowUnknownModels: false,
      credentials: { resolve: () => Promise.resolve({ apiKey: "fake-shared-secret" }) },
      transport: { fetch: router },
    };

    const ai = createAISubsystem({
      modelSources: [catalogSource([modelA, modelB])],
      providers: [binding],
      adapters: [createOpenAICompatibleApiAdapter(), createAnthropicMessagesApiAdapter()],
    });

    return { ai, openAIRequests, anthropicRequests };
  }

  it("dispatches each model by its own descriptor through one provider binding", async () => {
    const { ai, openAIRequests, anthropicRequests } = sharedProviderHarness();

    const fromA = await ai.gateway.complete({
      model: { provider: SHARED_PROVIDER, model: "shared-model-a" },
      messages: [{ role: "user", content: "hello" }],
    });
    const fromB = await ai.gateway.complete({
      model: { provider: SHARED_PROVIDER, model: "shared-model-b" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fromA.resolution.api).toBe(OPENAI_API);
    expect(fromB.resolution.api).toBe(ANTHROPIC_API);
    expect(fromA.text).toBe("openai answer");
    expect(fromB.text).toBe("anthropic answer");
    expect(openAIRequests).toHaveLength(1);
    expect(anthropicRequests).toHaveLength(1);
  });

  it("reports one provider and two dialects in the same registries", () => {
    const { ai } = sharedProviderHarness();

    expect(ai.providers.list()).toHaveLength(1);
    expect([...ai.adapters.listIds()].sort()).toEqual([ANTHROPIC_API, OPENAI_API]);
  });
});