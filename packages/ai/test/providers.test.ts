import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createProviderRegistryBuilder } from "../src/providers/provider-registry-builder.js";
import type { AIProviderBinding } from "../src/providers/provider-binding.js";
import type { ProviderCredentials } from "../src/providers/credentials.js";

const SECRET = "fake-api-secret-123";

function credentials(): ProviderCredentials {
  return { apiKey: SECRET, headers: { "x-tenant": "acme" } };
}

function binding(overrides: Partial<AIProviderBinding> = {}): AIProviderBinding {
  return {
    id: "openai",
    endpoint: "https://api.openai.example/v1",
    defaultApi: "openai-compatible-chat",
    allowUnknownModels: false,
    credentials: { resolve: () => Promise.resolve(credentials()) },
    ...overrides,
  };
}

describe("ProviderCredentialResolver", () => {
  it("resolves credentials asynchronously", async () => {
    let resolved = false;
    const registry = createProviderRegistryBuilder()
      .register(
        binding({
          credentials: {
            resolve: async (signal) => {
              await Promise.resolve();
              expect(signal).toBeInstanceOf(AbortSignal);
              resolved = true;
              return credentials();
            },
          },
        }),
      )
      .build();

    const result = await registry.get("openai").credentials.resolve(new AbortController().signal);

    expect(resolved).toBe(true);
    expect(result.apiKey).toBe(SECRET);
  });
});

describe("ProviderRegistryBuilder validation", () => {
  it("accepts http and https endpoints", () => {
    for (const endpoint of [
      "https://api.openai.example/v1",
      "http://localhost:8080",
      "https://api.example.com:8443/v1/",
      "https://api.example.com/v1?x=1",
    ]) {
      expect(() => createProviderRegistryBuilder().register(binding({ endpoint }))).not.toThrow();
    }
  });

  it("rejects an endpoint that is not an absolute http(s) URL", () => {
    for (const endpoint of [
      "",
      "api.openai.example",
      "ftp://api.openai.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "//api.openai.example",
      "https://",
    ]) {
      expect(
        () => createProviderRegistryBuilder().register(binding({ endpoint })),
        endpoint,
      ).toThrow(TypeError);
    }
  });

  it("rejects an invalid provider or api id", () => {
    for (const overrides of [
      { id: "" },
      { id: "OpenAI" },
      { id: "1openai" },
      { id: "openai compatible" },
      { defaultApi: "" },
      { defaultApi: "OpenAI-Chat" },
      { defaultApi: "openai.chat" },
    ] as Partial<AIProviderBinding>[]) {
      expect(() => createProviderRegistryBuilder().register(binding(overrides))).toThrow(TypeError);
    }
  });

  it("rejects a binding without a credential resolver or with a non-boolean gate", () => {
    for (const overrides of [
      { credentials: undefined },
      { credentials: {} },
      { credentials: { resolve: "nope" } },
      { allowUnknownModels: undefined },
      { allowUnknownModels: "yes" },
    ] as unknown as Partial<AIProviderBinding>[]) {
      expect(() => createProviderRegistryBuilder().register(binding(overrides))).toThrow(TypeError);
    }
  });

  it("rejects duplicate providers, including a duplicate allowedModels entry", () => {
    expect(() => createProviderRegistryBuilder().register(binding()).register(binding())).toThrow(
      TypeError,
    );

    for (const allowedModels of [["a", "a"], [""], ["a", 1], "a"]) {
      expect(() =>
        createProviderRegistryBuilder().register(
          binding({ allowedModels: allowedModels as unknown as readonly string[] }),
        ),
      ).toThrow(TypeError);
    }
  });

  it("rejects malformed header, query and compatibility maps", () => {
    for (const overrides of [
      { headers: { "x-a": 1 } },
      { headers: [] },
      { headers: null },
      { queryParams: { a: undefined } },
      { queryParams: "a=1" },
      { compatibility: { fn: () => undefined } },
      { compatibility: { nested: Number.NaN } },
      { compatibility: [] },
      { compatibility: 1 },
      { transport: { fetch: "nope" } },
    ] as unknown as Partial<AIProviderBinding>[]) {
      expect(() => createProviderRegistryBuilder().register(binding(overrides))).toThrow(TypeError);
    }
  });

  it("rejects an unknown binding field", () => {
    expect(() =>
      createProviderRegistryBuilder().register({
        ...binding(),
        apiKey: SECRET,
      } as AIProviderBinding),
    ).toThrow(TypeError);

    expect(() =>
      createProviderRegistryBuilder().register({
        ...binding(),
        endpoint: "https://api.openai.example/v1",
        unknownField: true,
      } as unknown as AIProviderBinding),
    ).toThrow(TypeError);
  });
});

describe("ProviderRegistry", () => {
  it("gets a binding and reports membership", () => {
    const registry = createProviderRegistryBuilder()
      .register(binding({ allowedModels: ["gpt-5"], allowUnknownModels: true }))
      .build();

    expect(registry.has("openai")).toBe(true);
    expect(registry.has("azure")).toBe(false);
    expect(registry.get("openai").endpoint).toBe("https://api.openai.example/v1");
    expect(registry.get("openai").defaultApi).toBe("openai-compatible-chat");
    expect(registry.get("openai").allowedModels).toEqual(["gpt-5"]);
    expect(registry.get("openai").allowUnknownModels).toBe(true);
  });

  it("fails with AI_PROVIDER_NOT_FOUND for a missing provider", () => {
    const registry = createProviderRegistryBuilder().register(binding()).build();

    try {
      registry.get("azure");
      expect.unreachable("get must throw for a missing provider");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_PROVIDER_NOT_FOUND");
      expect((error as AIError).retryable).toBe(false);
      expect((error as AIError).providerId).toBe("azure");
    }
  });

  it("lists secret-safe provider descriptors", () => {
    const registry = createProviderRegistryBuilder()
      .register(
        binding({
          headers: { "x-tenant": "acme" },
          queryParams: { "api-version": "2024-01-01" },
          compatibility: { dialectRevision: 3 },
          allowedModels: ["gpt-5"],
        }),
      )
      .build();

    const descriptors = registry.list();

    expect(descriptors).toHaveLength(1);
    expect(Object.keys(descriptors[0] ?? {}).sort()).toEqual([
      "allowUnknownModels",
      "allowedModels",
      "configured",
      "defaultApi",
      "id",
    ]);

    const serialized = JSON.stringify(descriptors);
    for (const forbidden of [
      SECRET,
      "apiKey",
      "bearerToken",
      "credentials",
      "headers",
      "queryParams",
      "x-tenant",
      "compatibility",
      "transport",
      "endpoint",
      "https://api.openai.example",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(descriptors[0]?.configured).toBe(true);
  });

  it("keeps list() deterministically ordered and immutable after build", () => {
    const builder = createProviderRegistryBuilder();
    const allowedModels = ["gpt-5"];
    builder
      .register(binding({ id: "zeta", allowedModels }))
      .register(binding({ id: "alpha" }))
      .register(binding({ id: "mid" }));

    const registry = builder.build();

    expect(registry.list().map((entry) => entry.id)).toEqual(["alpha", "mid", "zeta"]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(() => builder.register(binding({ id: "late" }))).toThrow(TypeError);
    expect(() => builder.build()).toThrow(TypeError);

    // Caller mutation after build cannot change what the registry reports.
    allowedModels.push("smuggled");
    expect(registry.get("zeta").allowedModels).toEqual(["gpt-5"]);
  });

  it("preserves an installable transport override and compatibility object", () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("unused"))) as unknown as typeof globalThis.fetch;
    const registry = createProviderRegistryBuilder()
      .register({
        ...binding(),
        compatibility: { dialectRevision: 3 },
        transport: { fetch: fetchImpl },
      })
      .build();

    expect(registry.get("openai").transport?.fetch).toBe(fetchImpl);
    expect(registry.get("openai").compatibility).toEqual({ dialectRevision: 3 });
  });
});
