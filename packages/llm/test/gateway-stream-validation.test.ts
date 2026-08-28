import { describe, expect, it } from "vitest";
import {
  LLMGateway,
  LLMInvalidResponseError,
  LLMProviderRegistry,
} from "../src/index.js";
import type { LLMProviderCallContext, LLMProviderRequest } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };

type RawEventsFactory = (request: LLMProviderRequest, context: LLMProviderCallContext) => readonly unknown[];

function gatewayWithEvents(rawEventsForContext: RawEventsFactory) {
  const provider = new FakeLLMProvider({ id: "local", rawEventsForContext });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

async function consume(gateway: LLMGateway, request = { model, messages: [] }): Promise<void> {
  const stream = gateway.stream(request);
  for await (const _event of stream.events) {
    // Consume all downstream events.
  }
}

describe("LLM gateway stream validation", () => {
  it("requires one matching stream.start and stream.finish", async () => {
    const gateway = gatewayWithEvents((_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    await expect(consume(gateway)).resolves.toBeUndefined();
  });

  const invalidFactories: ReadonlyArray<readonly [string, RawEventsFactory]> = [
    ["missing start", (_request, _context) => [{ type: "stream.finish", payload: { finishReason: "STOP" } }]],
    ["duplicate start", (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]],
    ["missing finish", (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
    ]],
    ["event after finish", (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
      { type: "text.delta", payload: { text: "late" } },
    ]],
    ["malformed event", (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "text.delta", payload: { text: "" } },
    ]],
  ];

  it.each(invalidFactories)("rejects %s", async (_name, events) => {
    await expect(consume(gatewayWithEvents(events))).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });

  it.each(["call id", "provider id", "model"] as const)("rejects mismatched start %s", async (name) => {
    await expect(
      consume(
        gatewayWithEvents((_request, context) => [
          {
            type: "stream.start",
            payload: {
              callId: name === "call id" ? `${context.callId}-wrong` : context.callId,
              providerId: name === "provider id" ? "other" : "local",
              model: name === "model" ? { provider: "local", model: "other" } : model,
            },
          },
          { type: "stream.finish", payload: { finishReason: "STOP" } },
        ]),
      ),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });
});
