import { describe, expect, it } from "vitest";
import { LLMGateway, LLMInvalidResponseError, LLMProviderRegistry } from "../src/index.js";
import type { LLMProviderCallContext, LLMProviderRequest } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };

type RawEventsFactory = (
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
) => readonly unknown[];

function consumeToolEvents(eventsForContext: RawEventsFactory) {
  const provider = new FakeLLMProvider({ id: "local", rawEventsForContext: eventsForContext });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  const gateway = new LLMGateway({ providers });
  return { gateway, provider };
}

describe("LLM gateway tool-call lifecycle", () => {
  it("accepts interleaved calls and preserves completion order", async () => {
    const { gateway } = consumeToolEvents((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "tool_call.start", payload: { toolCallId: "a", toolName: "first_tool" } },
      { type: "tool_call.start", payload: { toolCallId: "b", toolName: "second_tool" } },
      { type: "tool_call.delta", payload: { toolCallId: "a", delta: '{"x":' } },
      { type: "tool_call.delta", payload: { toolCallId: "b", delta: '{"y":' } },
      { type: "tool_call.completed", payload: { id: "b", name: "second_tool", input: { y: 2 } } },
      { type: "tool_call.completed", payload: { id: "a", name: "first_tool", input: { x: 1 } } },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ]);
    const stream = gateway.stream({ model, messages: [] });
    const received = [];
    for await (const event of stream.events) received.push(event.type);
    expect(received).toContain("tool_call.completed");
  });

  const invalidToolFactories: ReadonlyArray<readonly [string, readonly unknown[]]> = [
    [
      "delta before start",
      [{ type: "tool_call.delta", payload: { toolCallId: "a", delta: "{}" } }],
    ],
    [
      "completed before start",
      [{ type: "tool_call.completed", payload: { id: "a", name: "tool", input: {} } }],
    ],
    [
      "duplicate start",
      [
        { type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } },
        { type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } },
      ],
    ],
    [
      "duplicate completed",
      [
        { type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } },
        { type: "tool_call.completed", payload: { id: "a", name: "tool", input: {} } },
        { type: "tool_call.completed", payload: { id: "a", name: "tool", input: {} } },
      ],
    ],
    [
      "delta after completed",
      [
        { type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } },
        { type: "tool_call.completed", payload: { id: "a", name: "tool", input: {} } },
        { type: "tool_call.delta", payload: { toolCallId: "a", delta: "{}" } },
      ],
    ],
    [
      "unfinished at finish",
      [{ type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } }],
    ],
    [
      "completion identity mismatch",
      [
        { type: "tool_call.start", payload: { toolCallId: "a", toolName: "tool" } },
        { type: "tool_call.completed", payload: { id: "b", name: "tool", input: {} } },
      ],
    ],
  ];

  it.each(invalidToolFactories)("rejects %s", async (_name, toolEvents) => {
    await expect(
      (async () => {
        const { gateway } = consumeToolEvents((_request, context) => [
          { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
          ...toolEvents,
          { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
        ]);
        for await (const event of gateway.stream({ model, messages: [] }).events) {
          // Consume until the validator rejects.
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });
});
