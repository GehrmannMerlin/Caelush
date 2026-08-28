import { describe, expect, it, vi } from "vitest";
import { LLMAbortedError, LLMGateway, LLMProviderRegistry, LLMTimeoutError } from "../src/index.js";
import type { LLMProviderCallContext, LLMProviderRequest } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };
type EventFactory = (
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
) => readonly unknown[];

function createAbortFixture(waitUntilAborted: boolean, eventsForContext: EventFactory) {
  const provider = new FakeLLMProvider({
    id: "local",
    waitUntilAborted,
    rawEventsForContext: eventsForContext,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return { gateway: new LLMGateway({ providers }), provider };
}

async function waitForProviderCall(provider: FakeLLMProvider): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (provider.streamCallCount > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("fake provider did not start");
}

describe("LLM gateway abort scope", () => {
  it("throws LLMAbortedError without invoking a pre-aborted provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gateway, provider } = createAbortFixture(false, () => []);
    const stream = gateway.stream({ model, messages: [] }, { signal: controller.signal });

    await expect(
      (async () => {
        for await (const event of stream.events) {
          // The pre-abort must fail before the first provider event.
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(provider.streamCallCount).toBe(0);
  });

  it("propagates external abort to the provider and preserves its error class", async () => {
    const controller = new AbortController();
    const { gateway, provider } = createAbortFixture(true, (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
    ]);
    const consuming = (async () => {
      for await (const event of gateway.stream(
        { model, messages: [] },
        { signal: controller.signal },
      ).events) {
        // Keep consuming until the external controller aborts.
        void event;
      }
    })();
    await waitForProviderCall(provider);
    controller.abort();

    await expect(consuming).rejects.toBeInstanceOf(LLMAbortedError);
    expect(provider.lastSignal?.aborted).toBe(true);
    expect(provider.iteratorCleanup).toBe(true);
  });

  it("aborts the provider on timeout with LLMTimeoutError", async () => {
    const { gateway, provider } = createAbortFixture(true, (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
    ]);
    const consuming = (async () => {
      for await (const event of gateway.stream({ model, messages: [] }, { timeoutMs: 10 }).events) {
        // Keep consuming until the gateway timeout fires.
        void event;
      }
    })();
    await waitForProviderCall(provider);

    await expect(consuming).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(provider.lastSignal?.aborted).toBe(true);
    expect(provider.iteratorCleanup).toBe(true);
  });

  it("aborts and cleans up the provider when the consumer breaks early", async () => {
    const { gateway, provider } = createAbortFixture(true, (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
    ]);
    for await (const event of gateway.stream({ model, messages: [] }).events) {
      void event;
      break;
    }

    expect(provider.lastSignal?.aborted).toBe(true);
    expect(provider.iteratorCleanup).toBe(true);
  });

  it("clears the timeout after a normal finish", async () => {
    vi.useFakeTimers();
    try {
      const { gateway } = createAbortFixture(false, (_request, context) => [
        { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
        { type: "stream.finish", payload: { finishReason: "STOP" } },
      ]);
      for await (const event of gateway.stream({ model, messages: [] }).events) {
        // Consume the complete turn.
        void event;
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
