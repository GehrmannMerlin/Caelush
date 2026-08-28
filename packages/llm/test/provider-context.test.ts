import { createLLMCallId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { LLMProviderCallContext } from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

describe("LLM provider call context", () => {
  it("delivers the gateway-owned call id and abort signal to the provider", async () => {
    const provider = new FakeLLMProvider({
      id: "local",
      events: [{ type: "stream.finish", payload: { finishReason: "STOP" } }],
    });
    const context: LLMProviderCallContext = {
      callId: createLLMCallId(),
      signal: new AbortController().signal,
    };

    for await (const event of provider.stream(
      { model: { provider: "local", model: "test-model" }, messages: [] },
      context,
    )) {
      // Consume the deterministic provider turn.
      void event;
    }

    expect(provider.observedContexts).toEqual([context]);
    expect(provider.lastCallId).toBe(context.callId);
    expect(provider.lastSignal).toBe(context.signal);
  });
});
