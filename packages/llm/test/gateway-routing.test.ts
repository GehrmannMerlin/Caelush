import { describe, expect, it } from "vitest";
import {
  LLMGateway,
  LLMModelUnsupportedError,
  LLMProviderNotFoundError,
  LLMProviderRegistry,
} from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };
const request = { model, messages: [] };

function createGateway(provider = "local") {
  const fake = new FakeLLMProvider({
    id: provider,
    eventsForContext: (_request, context) => [
      {
        type: "stream.start",
        payload: { callId: context.callId, providerId: provider, model },
      },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ],
    supportsModel: (candidate) => candidate.model === "test-model",
  });
  const providers = new LLMProviderRegistry();
  providers.register(fake);
  return { gateway: new LLMGateway({ providers }), fake };
}

describe("LLM gateway routing", () => {
  it("routes by ModelRef.provider and creates a lazy gateway call", async () => {
    const { gateway, fake } = createGateway();
    const stream = gateway.stream(request);

    expect(stream.callId).toMatch(/^llm_/);
    expect(fake.streamCallCount).toBe(0);

    const received = [];
    for await (const event of stream.events) received.push(event);

    expect(fake.streamCallCount).toBe(1);
    expect(fake.lastCallId).toBe(stream.callId);
    expect(received[0]).toMatchObject({ type: "stream.start", payload: { callId: stream.callId } });
  });

  it("fails synchronously when the provider is missing or model is unsupported", () => {
    const providers = new LLMProviderRegistry();
    const gateway = new LLMGateway({ providers });
    expect(() => gateway.stream(request)).toThrow(LLMProviderNotFoundError);

    const { gateway: unsupportedGateway } = createGateway();
    expect(() =>
      unsupportedGateway.stream({ model: { ...model, model: "other-model" }, messages: [] }),
    ).toThrow(LLMModelUnsupportedError);
  });
});
