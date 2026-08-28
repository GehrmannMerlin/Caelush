import { describe, expect, it } from "vitest";
import { LLMGateway, LLMProviderRegistry } from "../src/index.js";
import type { LLMProviderCallContext, LLMProviderRequest, LLMStreamEvent } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };
type EventFactory = (
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
) => readonly LLMStreamEvent[];

function createGateway(eventsForContext: EventFactory) {
  const provider = new FakeLLMProvider({ id: "local", eventsForContext });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return { gateway: new LLMGateway({ providers }), provider };
}

describe("LLM gateway complete aggregation", () => {
  it("aggregates text deltas into one provider-turn result", async () => {
    const { gateway, provider } = createGateway((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "text.delta", payload: { text: "Hel" } },
      { type: "text.delta", payload: { text: "lo" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);

    await expect(gateway.complete({ model, messages: [] })).resolves.toMatchObject({
      providerId: "local",
      model,
      text: "Hello",
      toolCalls: [],
      finishReason: "STOP",
    });
    expect(provider.streamCallCount).toBe(1);
  });

  it("aggregates completed tool calls only in completion order", async () => {
    const { gateway, provider } = createGateway((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "tool_call.start", payload: { toolCallId: "a", toolName: "first_tool" } },
      { type: "tool_call.start", payload: { toolCallId: "b", toolName: "second_tool" } },
      {
        type: "tool_call.completed",
        payload: { id: "b", name: "second_tool", input: { order: 2 } },
      },
      {
        type: "tool_call.completed",
        payload: { id: "a", name: "first_tool", input: { order: 1 } },
      },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ]);

    const result = await gateway.complete({ model, messages: [] });
    expect(result.text).toBe("");
    expect(result.toolCalls.map((call) => call.id)).toEqual(["b", "a"]);
    expect(provider.streamCallCount).toBe(1);
  });
});
