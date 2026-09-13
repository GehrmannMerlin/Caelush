import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { createAnthropicMessagesApiAdapter } from "../../../src/adapters/anthropic-messages/index.js";
import { modelDescriptor } from "../../support/fixtures.js";
import {
  capturingTransport,
  messageDelta,
  messageStart,
  messageStop,
  blockStop,
  sseResponse,
  textBlockStart,
  textDelta,
} from "../../support/anthropic-messages-transport.js";
import type { AIProviderBinding } from "../../../src/providers/provider-binding.js";
import type { CapturingTransport } from "../../support/anthropic-messages-transport.js";
import type { EnumerableModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";

const API_ID = "anthropic-messages";
const SECRET_A = "fake-anthropic-secret-a";
const SECRET_B = "fake-anthropic-secret-b";

/**
 * One catalog describing whatever model id is asked for.
 *
 * Both providers serve the same model id through the same dialect, so the only
 * variables under test are the provider, its endpoint and its credential.
 */
const catalogSource: EnumerableModelDescriptorSourcePort = {
  id: "shared-catalog",
  priority: 0,
  resolve: (ref) => modelDescriptor({ ref, api: API_ID }),
  list: () => [],
};

/** One complete native text turn naming the provider that served it. */
function servedBy(providerId: string): Response {
  return sseResponse([
    messageStart({ input_tokens: 3, output_tokens: 0 }, `msg_${providerId}`),
    textBlockStart(0),
    textDelta(0, `served by ${providerId}`),
    blockStop(0),
    messageDelta("end_turn", { output_tokens: 4 }),
    messageStop(),
  ]);
}

interface Harness {
  readonly ai: ReturnType<typeof createAISubsystem>;
  readonly transportA: CapturingTransport;
  readonly transportB: CapturingTransport;
  readonly adapter: ReturnType<typeof createAnthropicMessagesApiAdapter>;
}

/**
 * Two Anthropic Messages providers, two endpoints, two credentials, **one** adapter
 * instance.
 *
 * This is the pure-core proof that an API dialect is not a provider: neither
 * provider needs its own adapter, and the gateway never consults a provider name to
 * decide how to behave.
 */
function harness(): Harness {
  const transportA = capturingTransport(() => servedBy("provider-a"));
  const transportB = capturingTransport(() => servedBy("provider-b"));
  // The single adapter instance both providers share.
  const adapter = createAnthropicMessagesApiAdapter();

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
    modelSources: [catalogSource],
    providers: [
      binding("provider-a", "https://a.example", SECRET_A, transportA),
      binding("provider-b", "https://b.example", SECRET_B, transportB),
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

describe("two Anthropic Messages providers served by one adapter", () => {
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
    expect(fromA.model).toEqual({ provider: "provider-a", model: "shared-model" });
    expect(fromB.model).toEqual({ provider: "provider-b", model: "shared-model" });
    expect(fromA.resolution.api).toBe(API_ID);
    expect(fromB.resolution.api).toBe(API_ID);
  });

  it("routes each provider to its own endpoint", async () => {
    const { ai, transportA, transportB } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(transportA.requests[0]?.url).toBe("https://a.example/v1/messages");
    expect(transportB.requests[0]?.url).toBe("https://b.example/v1/messages");
    expect(transportA.requests[0]?.url).not.toContain("b.example");
    expect(transportB.requests[0]?.url).not.toContain("a.example");
  });

  it("keeps each provider's credential isolated to its own transport", async () => {
    const { ai, transportA, transportB } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(transportA.requests[0]?.headers["x-api-key"]).toBe(SECRET_A);
    expect(transportA.requests[0]?.headers["x-tenant"]).toBe("provider-a");
    expect(transportB.requests[0]?.headers["x-api-key"]).toBe(SECRET_B);
    expect(transportB.requests[0]?.headers["x-tenant"]).toBe("provider-b");
    // No cross-contamination in either direction.
    expect(JSON.stringify(transportA.requests[0]?.headers)).not.toContain(SECRET_B);
    expect(JSON.stringify(transportB.requests[0]?.headers)).not.toContain(SECRET_A);
  });

  it("never sends a credential in the request body", async () => {
    const { ai, transportA, transportB } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(transportA.requests[0]?.bodyText).not.toContain(SECRET_A);
    expect(transportB.requests[0]?.bodyText).not.toContain(SECRET_B);
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
        "x-api-key",
        "apiKey",
      ]) {
        expect(serialized, `${providerId}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never creates a provider-specific adapter", () => {
    const { ai } = harness();

    // The only registered dialect is the shared one, because a provider is
    // configuration, not a code path.
    expect(ai.adapters.listIds()).toHaveLength(1);
    expect(ai.providers.list().map((provider) => provider.defaultApi)).toEqual([API_ID, API_ID]);
  });

  it("reuses one adapter instance for both providers by identity", async () => {
    const { ai, adapter } = harness();

    await ai.gateway.complete(request("provider-a"));
    await ai.gateway.complete(request("provider-b"));

    expect(ai.adapters.get(API_ID)).toBe(adapter);
    expect(ai.adapters.listIds()).toHaveLength(1);
  });
});
