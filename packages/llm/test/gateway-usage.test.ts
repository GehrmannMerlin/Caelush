import { describe, expect, it } from "vitest";
import { LLMGateway, LLMProviderRegistry } from "../src/index.js";
import type {
  LLMProviderCallContext,
  LLMProviderRequest,
  LLMStreamEvent,
} from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };
type EventFactory = (request: LLMProviderRequest, context: LLMProviderCallContext) => readonly LLMStreamEvent[];

function createGateway(eventsForContext: EventFactory) {
  const provider = new FakeLLMProvider({ id: "local", eventsForContext });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return { gateway: new LLMGateway({ providers }), provider };
}

async function completeWith(eventsForContext: EventFactory) {
  const { gateway, provider } = createGateway(eventsForContext);
  const result = await gateway.complete({ model, messages: [] });
  return { result, provider };
}

describe("LLM gateway usage aggregation", () => {
  it("uses the last usage snapshot and finish finalUsage without double counting", async () => {
    const { result } = await completeWith((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "usage", payload: { inputTokens: 100, outputTokens: 20 } },
      { type: "usage", payload: { inputTokens: 110, outputTokens: 22 } },
      {
        type: "stream.finish",
        payload: {
          finishReason: "STOP",
          finalUsage: { inputTokens: 120, outputTokens: 24 },
        },
      },
    ]);

    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 24 });
    expect(result.usage?.totalTokens).toBeUndefined();
  });

  it("omits usage when the provider reports no usage", async () => {
    const { result } = await completeWith((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);

    expect(result).not.toHaveProperty("usage");
  });
});
