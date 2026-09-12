import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  finishChunk,
  openAIChunk,
  sseResponse,
} from "../../support/openai-compatible-transport.js";
import type { AIProviderBinding } from "../../../src/providers/provider-binding.js";
import type { CapturingTransport } from "../../support/openai-compatible-transport.js";
import type { EnumerableModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";

/** One shared model catalog describing whatever model id is asked for. */
const catalogSource: EnumerableModelDescriptorSourcePort = {
  id: "shared-catalog",
  priority: 0,
  resolve: (ref) => modelDescriptor({ ref, api: API_ID }),
  list: () => [],
};

const API_ID = "openai-compatible-chat";
const SECRET_A = "fake-api-secret-123";
const SECRET_B = "fake-api-secret-456";

/** One complete text turn naming the provider that served it. */
function servedBy(providerId: string): Response {
  return sseResponse([
    openAIChunk({
      id: `chatcmpl-${providerId}`,
      model: "shared-model",
      delta: { role: "assistant", content: `served by ${providerId}` },
    }),
    finishChunk({ id: `chatcmpl-${providerId}`, model: "shared-model", finishReason: "stop" }),
  ]);
}

interface Harness {
  readonly ai: ReturnType<typeof createAISubsystem>;
  readonly transportA: CapturingTransport;
  readonly transportB: CapturingTransport;
  readonly adapter: ReturnType<typeof createOpenAICompatibleApiAdapter>;
}

/**
 * Two providers, two endpoints, two credentials, **one** adapter instance.
 *
 * This is the pure-core proof that a model, a provider and an API dialect are three
 * different things: neither provider needs its own adapter, and the gateway never
 * consults a provider name to decide how to behave.
 */
function harness(): Harness {
  const transportA = capturingTransport(() => servedBy("provider-a"));
  const transportB = capturingTransport(() => servedBy("provider-b"));
  // The single adapter instance both providers share.
  const adapter = createOpenAICompatibleApiAdapter();

  const binding = (
    id: string,
    endpoint: string,
    secret: string,
    transport: CapturingTransport,
  ): AIProviderBinding => ({
    id,
    endpoint,
    defaultApi: API_ID,
    allowUnknownModels: false,
    credentials: {
      resolve: () => Promise.resolve({ apiKey: secret, headers: { "x-tenant": id } }),
    },
    transport: { fetch: transport.fetch },
  });

  const ai = createAISubsystem({
    // One shared catalog: both providers describe the same model id through the same
    // API dialect, so exactly the model/provider/dialect separation is under test.
    modelSources: [catalogSource],
    providers: [
      binding("provider-a", "http://a.example/v1", SECRET_A, transportA),
      binding("provider-b", "http://b.example/v1", SECRET_B, transportB),
    ],
    adapters: [adapter],
  });

  return { ai, transportA, transportB, adapter };
}

function request(providerId: string) {
  return {
    model: { provider: providerId, model: "shared-model" },
    messages: [{ role: "user" as const, content: "hello" }],
  };
}

describe("two providers served by one OpenAI-compatible adapter", () => {
  it("registers exactly one adapter for the shared dialect", () => {
    const { ai, adapter } = harness();

    expect(ai.adapters.listIds()).toEqual([API_ID]);
    expect(ai.adapters.get(API_ID)).toBe(adapter);
  });
  it("runs both providers through the same adapter and gateway", async () => {
    const { ai } = harness();

    const fromA = await ai.gateway.complete(request("provider-a"));
    const fromB = await ai.gateway.complete(request("provider-b"));

    expect(fromA.text).toBe("served by provider-a");
    expect(fromB.text).toBe("served by provider-b");
    expect(fromA.providerId).toBe("provider-a");
    expect(fromB.providerId).toBe("provider-b");
    // Different providers, same model id and same API dialect.
    expect(fromA.model).toEqual({ provider: "provider-a", model: "shared-model" });
    expect(fromB.model).toEqual({ provider: "provider-b", model: "shared-model" });
    expect(fromA.resolution.api).toBe(API_ID);
    expect(fromB.resolution.api).toBe(API_ID);
  });

  it("routes each provider to its own endpoint", async () => {
    const { ai, transportA, transportB } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(transportA.requests[0]?.url).toContain("a.example");
    expect(transportB.requests[0]?.url).toContain("b.example");
    expect(transportA.requests[0]?.url).not.toContain("b.example");
    expect(transportB.requests[0]?.url).not.toContain("a.example");
  });

  it("keeps each provider's credential isolated to its own transport", async () => {
    const { ai, transportA, transportB } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(transportA.requests[0]?.headers["authorization"]).toBe(`Bearer ${SECRET_A}`);
    expect(transportA.requests[0]?.headers["x-tenant"]).toBe("provider-a");
    expect(transportB.requests[0]?.headers["authorization"]).toBe(`Bearer ${SECRET_B}`);
    expect(transportB.requests[0]?.headers["x-tenant"]).toBe("provider-b");
    // No cross-contamination in either direction.
    expect(JSON.stringify(transportA.requests[0]?.headers)).not.toContain(SECRET_B);
    expect(JSON.stringify(transportB.requests[0]?.headers)).not.toContain(SECRET_A);
  });

  it("leaks neither credential nor endpoint into the public stream", async () => {
    const { ai } = harness();

    for (const providerId of ["provider-a", "provider-b"]) {
      const stream = await ai.gateway.stream(request(providerId));
      const events = [];
      for await (const event of stream.events) events.push(event);
      const serialized = JSON.stringify(events);

      for (const forbidden of [
        SECRET_A,
        SECRET_B,
        "a.example",
        "b.example",
        "authorization",
        "apiKey",
      ]) {
        expect(serialized, `${providerId}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never creates a provider-specific adapter", () => {
    const { ai } = harness();

    // The only registered dialect is the shared one; no DeepSeek/Qwen/OpenRouter
    // adapter exists, because a provider is configuration, not a code path.
    expect(ai.adapters.listIds()).toHaveLength(1);
    expect(ai.providers.list().map((provider) => provider.defaultApi)).toEqual([API_ID, API_ID]);
  });
});
