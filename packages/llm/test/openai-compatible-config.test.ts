import { describe, expect, it } from "vitest";
import type { LLMCapabilities } from "../src/index.js";
import type { OpenAICompatibleLLMProviderOptions } from "../src/index.js";
import { createOpenAICompatibleLLMProvider } from "../src/index.js";

const unknownCapabilities: LLMCapabilities = {
  textStreaming: "UNKNOWN",
  toolCalling: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

describe("OpenAI-compatible provider configuration", () => {
  it("creates a provider from explicit runtime configuration", () => {
    const options: OpenAICompatibleLLMProviderOptions = {
      id: "local-openai",
      baseURL: "http://127.0.0.1:1234/custom",
      apiKey: "CAELUSH_TEST_SECRET_DO_NOT_LEAK_42",
      capabilities: unknownCapabilities,
      allowedModels: ["demo"],
    };

    const provider = createOpenAICompatibleLLMProvider(options);

    expect(provider.id).toBe("local-openai");
    expect(
      provider.supportsModel({
        provider: "local-openai",
        model: "demo",
        baseUrl: "http://127.0.0.1:1234/custom",
      }),
    ).toBe(true);
    expect(provider.getCapabilities({ provider: "local-openai", model: "demo" })).toEqual(
      unknownCapabilities,
    );
  });

  it("allows any non-empty model when no allowlist is configured", () => {
    const provider = createOpenAICompatibleLLMProvider({
      id: "local-openai",
      baseURL: "https://api.example.test/v1",
    });

    expect(provider.supportsModel({ provider: "local-openai", model: "any-model" })).toBe(true);
    expect(provider.getCapabilities({ provider: "local-openai", model: "any-model" })).toEqual({
      textStreaming: "SUPPORTED",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
    });
  });

  it("rejects a model from a different provider id", () => {
    const provider = createOpenAICompatibleLLMProvider({
      id: "local-openai",
      baseURL: "https://api.example.test/v1",
    });

    expect(provider.supportsModel({ provider: "other", model: "any-model" })).toBe(false);
  });

  it("rejects invalid provider ids and non-http base URLs", () => {
    expect(() =>
      createOpenAICompatibleLLMProvider({
        id: "Invalid Provider",
        baseURL: "https://api.example.test/v1",
      }),
    ).toThrow();
    expect(() =>
      createOpenAICompatibleLLMProvider({
        id: "local-openai",
        baseURL: "ftp://api.example.test/v1",
      }),
    ).toThrow();
  });
});
