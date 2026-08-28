import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import type { LLMProvider } from "../src/index.js";
import { LLMProviderError, LLMProviderNotFoundError, LLMProviderRegistry } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

function provider(id: string): LLMProvider {
  return {
    id: id as LLMProvider["id"],
    supportsModel: () => true,
    getCapabilities: () => ({
      textStreaming: "UNKNOWN",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
    }),
    async *stream() {
      yield* [];
    },
  };
}

describe("LLM provider registry", () => {
  it("registers, looks up, checks, and lists providers in insertion order", () => {
    const registry = new LLMProviderRegistry();
    const first = provider("local");
    const second = provider("openai-compatible");

    registry.register(first);
    registry.register(second);

    expect(registry.get("local")).toBe(first);
    expect(registry.has("local")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.listProviderIds()).toEqual(["local", "openai-compatible"]);
  });

  it("isolates explicitly constructed registries and rejects missing providers", () => {
    const firstRegistry = new LLMProviderRegistry();
    const secondRegistry = new LLMProviderRegistry();
    const registeredProvider = provider("local");

    firstRegistry.register(registeredProvider);

    expect(firstRegistry.has("local")).toBe(true);
    expect(secondRegistry.has("local")).toBe(false);
    expect(() => secondRegistry.get("local")).toThrow(LLMProviderNotFoundError);
  });

  it("rejects duplicate and invalid provider ids without replacing providers", () => {
    const registry = new LLMProviderRegistry();
    const first = provider("local");
    const duplicate = provider("local");
    registry.register(first);

    expect(() => registry.register(duplicate)).toThrow(LLMProviderError);
    expect(registry.get("local")).toBe(first);
    expect(() => registry.register({ ...first, id: "Invalid Provider" })).toThrow(LLMProviderError);
  });

  it("uses the test fake as a deterministic provider-turn source", async () => {
    const fake = new FakeLLMProvider({
      id: "local",
      events: [
        { type: "text.delta", payload: { text: "hello" } },
        { type: "stream.finish", payload: { finishReason: "STOP" } },
      ],
    });
    const request = { model: { provider: "local", model: "test-model" }, messages: [] };
    const received = [];

    for await (const event of fake.stream(request, {
      callId: createLLMCallId(),
      signal: new AbortController().signal,
    })) {
      received.push(event);
    }

    expect(fake.observedRequest).toEqual(request);
    expect(received).toEqual(fake.events);
  });
});
