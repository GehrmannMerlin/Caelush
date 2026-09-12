import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createAISubsystem } from "../src/create-ai-subsystem.js";
import { createLLMCallId } from "../src/ids/llm-call-id.js";
import { modelDescriptor } from "./support/fixtures.js";
import { adapterEvents, createFakeAdapter, textTurn } from "./support/fake-adapter.js";
import {
  fakeCredentialResolver,
  fixedModelSource,
  testProviderBinding,
} from "./support/gateway-fixtures.js";
import type { AISubsystem } from "../src/create-ai-subsystem.js";
import type { AIErrorSanitizer } from "../src/errors/error-sanitizer.js";
import type { ModelDescriptorSourcePort } from "../src/models/model-descriptor-source-port.js";

const MODEL_A = modelDescriptor({
  ref: { provider: "test", model: "model-a" },
  api: "test-api",
});

/**
 * Build a complete AI subsystem with no Agent, Runtime, Storage, Daemon or
 * Workspace involved. This is the independent-use closure for Phase 2A.
 */
function subsystem(): AISubsystem {
  const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
  return createAISubsystem({
    modelSources: [fixedModelSource([MODEL_A])],
    providers: [testProviderBinding()],
    adapters: [adapter],
  });
}

describe("createAISubsystem", () => {
  it("composes an immutable subsystem", () => {
    const ai = subsystem();

    expect(Object.isFrozen(ai)).toBe(true);
    expect(ai.gateway).toBeDefined();
    expect(ai.models.list()).toHaveLength(1);
    expect(ai.providers.list().map((entry) => entry.id)).toEqual(["test"]);
    expect(ai.adapters.listIds()).toEqual(["test-api"]);
  });

  it("performs a complete model invocation through the gateway alone", async () => {
    const ai = subsystem();

    const result = await ai.gateway.complete({
      model: { provider: "test", model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("STOP");
    expect(result.providerId).toBe("test");
    expect(result.model).toEqual({ provider: "test", model: "model-a" });
    expect(result.callId).toMatch(/^llm_/);
    expect(result.toolCalls).toEqual([]);
    expect(result.resolution.api).toBe("test-api");
  });

  it("streams the full public envelope", async () => {
    const ai = subsystem();
    const stream = await ai.gateway.stream({
      model: { provider: "test", model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });

    const types: string[] = [];
    for await (const event of stream.events) types.push(event.type);

    expect(stream.callId).toMatch(/^llm_/);
    expect(types).toEqual(["stream.start", "text.delta", "stream.finish"]);
  });

  it("uses an injected call id factory", async () => {
    const fixed = createLLMCallId();
    const ai = createAISubsystem({
      modelSources: [fixedModelSource([MODEL_A])],
      providers: [testProviderBinding()],
      adapters: [createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")))],
      callIdFactory: { create: () => fixed },
    });

    const stream = await ai.gateway.stream({
      model: { provider: "test", model: "model-a" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(stream.callId).toBe(fixed);
  });

  it("validates provider dialect and model integrity at startup", () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));

    // A provider whose default dialect has no adapter.
    expect(() =>
      createAISubsystem({
        modelSources: [],
        providers: [testProviderBinding({ defaultApi: "missing-api" })],
        adapters: [adapter],
      }),
    ).toThrow(TypeError);

    // A model whose dialect has no adapter.
    expect(() =>
      createAISubsystem({
        modelSources: [
          fixedModelSource([modelDescriptor({ ref: MODEL_A.ref, api: "missing-api" })]),
        ],
        providers: [testProviderBinding()],
        adapters: [adapter],
      }),
    ).toThrow(TypeError);

    // A model that names an unconfigured provider.
    expect(() =>
      createAISubsystem({
        modelSources: [fixedModelSource([MODEL_A])],
        providers: [testProviderBinding({ id: "other" })],
        adapters: [adapter],
      }),
    ).toThrow(TypeError);
  });

  it("rejects duplicate model sources, providers and adapters", () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const source: ModelDescriptorSourcePort = fixedModelSource([MODEL_A]);

    expect(() =>
      createAISubsystem({
        modelSources: [source, source],
        providers: [testProviderBinding()],
        adapters: [adapter],
      }),
    ).toThrow(TypeError);

    expect(() =>
      createAISubsystem({
        modelSources: [source],
        providers: [testProviderBinding(), testProviderBinding()],
        adapters: [adapter],
      }),
    ).toThrow(TypeError);

    expect(() =>
      createAISubsystem({
        modelSources: [source],
        providers: [testProviderBinding()],
        adapters: [adapter, adapter],
      }),
    ).toThrow(TypeError);
  });

  it("rejects an invalid default timeout and a malformed sanitizer", () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const base = {
      modelSources: [fixedModelSource([MODEL_A])],
      providers: [testProviderBinding()],
      adapters: [adapter],
    };

    expect(() => createAISubsystem({ ...base, defaultTimeoutMs: 0 })).toThrow(TypeError);
    expect(() =>
      createAISubsystem({
        ...base,
        errorSanitizer: {} as unknown as AIErrorSanitizer,
      }),
    ).toThrow(TypeError);
  });
});

describe("two providers, one adapter", () => {
  /**
   * The pure-core proof that `Model != Provider != API dialect`: two providers
   * that speak one dialect share one adapter and run through one gateway, while
   * their endpoints and credentials stay distinct.
   */
  async function prove(): Promise<{
    ai: AISubsystem;
    seen: readonly { providerId: string; endpoint: string; credential: string | undefined }[];
  }> {
    const seen: { providerId: string; endpoint: string; credential: string | undefined }[] = [];
    const sharedAdapter = createFakeAdapter("test-api", (input) => {
      seen.push({
        providerId: input.provider.providerId,
        endpoint: input.provider.endpoint,
        credential: input.provider.credentials.apiKey,
      });
      return adapterEvents(...textTurn(`served by ${input.provider.providerId}`));
    });

    const ai = createAISubsystem({
      modelSources: [
        fixedModelSource([
          modelDescriptor({
            ref: { provider: "provider-a", model: "shared-model" },
            api: "test-api",
          }),
          modelDescriptor({
            ref: { provider: "provider-b", model: "shared-model" },
            api: "test-api",
          }),
        ]),
      ],
      providers: [
        testProviderBinding({
          id: "provider-a",
          endpoint: "https://a.example/v1",
          credentials: fakeCredentialResolver(() => Promise.resolve({ apiKey: "key-a" })),
        }),
        testProviderBinding({
          id: "provider-b",
          endpoint: "https://b.example/v1",
          credentials: fakeCredentialResolver(() => Promise.resolve({ apiKey: "key-b" })),
        }),
      ],
      adapters: [sharedAdapter],
    });

    return { ai, seen };
  }

  it("runs both providers through the same gateway and adapter", async () => {
    const { ai, seen } = await prove();

    const fromA = await ai.gateway.complete({
      model: { provider: "provider-a", model: "shared-model" },
      messages: [{ role: "user", content: "hello" }],
    });
    const fromB = await ai.gateway.complete({
      model: { provider: "provider-b", model: "shared-model" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fromA.text).toBe("served by provider-a");
    expect(fromB.text).toBe("served by provider-b");
    expect(fromA.providerId).toBe("provider-a");
    expect(fromB.providerId).toBe("provider-b");
    // Same model name, same dialect, same adapter, two distinct connections.
    expect(fromA.model).toEqual({ provider: "provider-a", model: "shared-model" });
    expect(fromB.model).toEqual({ provider: "provider-b", model: "shared-model" });
    expect(seen).toEqual([
      { providerId: "provider-a", endpoint: "https://a.example/v1", credential: "key-a" },
      { providerId: "provider-b", endpoint: "https://b.example/v1", credential: "key-b" },
    ]);
  });

  it("keeps the credentials and endpoint out of the public stream", async () => {
    const { ai } = await prove();

    const stream = await ai.gateway.stream({
      model: { provider: "provider-a", model: "shared-model" },
      messages: [{ role: "user", content: "hello" }],
    });

    const events = [];
    for await (const event of stream.events) events.push(event);
    const serialized = JSON.stringify(events);

    for (const forbidden of [
      "key-a",
      "key-b",
      "https://a.example",
      "https://b.example",
      "apiKey",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports a missing provider without touching the adapter", async () => {
    const { ai, seen } = await prove();

    await expect(
      ai.gateway.complete({
        model: { provider: "provider-c", model: "shared-model" },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(AIError);
    expect(seen).toEqual([]);
  });
});
