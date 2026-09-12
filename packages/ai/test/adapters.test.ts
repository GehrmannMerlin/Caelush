import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createApiAdapterRegistryBuilder } from "../src/adapters/api-adapter-registry-builder.js";
import type { AIAdapterEvent } from "../src/adapters/api-adapter-event.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../src/adapters/api-adapter.js";
import type { ApiId } from "../src/ids/api-id.js";

function fakeAdapter(id: ApiId, events: readonly AIAdapterEvent[] = []): ApiAdapter {
  return {
    id,
    async *stream(input: ApiAdapterStreamInput): AsyncIterable<AIAdapterEvent> {
      void input;
      yield* events;
    },
  };
}

describe("ApiAdapterRegistryBuilder", () => {
  it("registers an adapter and resolves it by api id", () => {
    const adapter = fakeAdapter("test-api");
    const registry = createApiAdapterRegistryBuilder().register(adapter).build();

    expect(registry.has("test-api")).toBe(true);
    expect(registry.get("test-api")).toBe(adapter);
  });

  it("rejects a duplicate api id", () => {
    expect(() =>
      createApiAdapterRegistryBuilder()
        .register(fakeAdapter("test-api"))
        .register(fakeAdapter("test-api")),
    ).toThrow(TypeError);
  });

  it("rejects a malformed adapter", () => {
    for (const adapter of [
      { id: "", stream: () => undefined },
      { id: "Bad-Id", stream: () => undefined },
      { id: "test-api" },
      { id: "test-api", stream: "nope" },
      { stream: () => undefined },
      null,
    ] as unknown as ApiAdapter[]) {
      expect(() => createApiAdapterRegistryBuilder().register(adapter)).toThrow(TypeError);
    }
  });

  it("rejects registration and a second build after build", () => {
    const builder = createApiAdapterRegistryBuilder().register(fakeAdapter("test-api"));
    builder.build();

    expect(() => builder.register(fakeAdapter("other-api"))).toThrow(TypeError);
    expect(() => builder.build()).toThrow(TypeError);
  });
});

describe("ApiAdapterRegistry", () => {
  it("fails with AI_ADAPTER_NOT_FOUND for an unregistered dialect", () => {
    const registry = createApiAdapterRegistryBuilder().register(fakeAdapter("test-api")).build();

    expect(registry.has("anthropic-messages")).toBe(false);
    try {
      registry.get("anthropic-messages");
      expect.unreachable("get must throw for a missing adapter");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_ADAPTER_NOT_FOUND");
      expect((error as AIError).retryable).toBe(false);
    }
  });

  it("lists api ids deterministically and immutably", () => {
    const registry = createApiAdapterRegistryBuilder()
      .register(fakeAdapter("zeta-api"))
      .register(fakeAdapter("alpha-api"))
      .register(fakeAdapter("mid-api"))
      .build();

    expect(registry.listIds()).toEqual(["alpha-api", "mid-api", "zeta-api"]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.listIds())).toBe(true);
  });

  it("supports one adapter serving several providers", () => {
    // The adapter registry is keyed by dialect, not by vendor: two providers that
    // speak the same dialect share exactly one adapter instance.
    const shared = fakeAdapter("test-api");
    const registry = createApiAdapterRegistryBuilder().register(shared).build();

    expect(registry.get("test-api")).toBe(shared);
    expect(registry.listIds()).toEqual(["test-api"]);
  });
});
