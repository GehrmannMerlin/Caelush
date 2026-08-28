import { describe, expect, it } from "vitest";
import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
} from "../src/index.js";
import { openAIChunk, sseResponse } from "./support/openai-compatible-sse.js";

const model = { provider: "compat-fixture", model: "fixture-model" };

function createGateway(fetch: typeof globalThis.fetch): LLMGateway {
  const provider = createOpenAICompatibleLLMProvider({
    id: "compat-fixture",
    baseURL: "http://127.0.0.1:4321/v1",
    fetch,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

describe("OpenAI-compatible compatibility matrix", () => {
  it("routes a real OpenAI-shaped SSE response through the adapter", async () => {
    const gateway = createGateway(async () =>
      sseResponse([
        openAIChunk({
          id: "chatcmpl-fixture",
          model: model.model,
          delta: { role: "assistant", content: "fixture ok" },
        }),
        openAIChunk({
          id: "chatcmpl-fixture",
          model: model.model,
          delta: {},
          finishReason: "stop",
        }),
      ]),
    );

    const result = await gateway.complete({
      model,
      messages: [{ role: "user", content: "Say fixture ok." }],
    });

    expect(result).toMatchObject({
      text: "fixture ok",
      toolCalls: [],
      finishReason: "STOP",
    });
  });
});
