import { describe, expect, it } from "vitest";
import {
  LLMAuthenticationError,
  LLMGateway,
  LLMNetworkError,
  LLMProviderError,
  LLMProviderRegistry,
  LLMRateLimitError,
} from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };

function gatewayWithError(error: unknown) {
  const provider = new FakeLLMProvider({ id: "local", events: [], error });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return { gateway: new LLMGateway({ providers }), provider };
}

async function consumeError(gateway: LLMGateway): Promise<void> {
  for await (const event of gateway.stream({ model, messages: [] }).events) {
    // The provider is expected to fail before producing a complete stream.
    void event;
  }
}

describe("LLM gateway provider errors", () => {
  it("preserves typed provider errors", async () => {
    const { gateway } = gatewayWithError(new LLMAuthenticationError("credentials rejected"));
    await expect(consumeError(gateway)).rejects.toBeInstanceOf(LLMAuthenticationError);
  });

  it.each([
    [LLMRateLimitError, "rate limit"],
    [LLMNetworkError, "network"],
  ] as const)("does not retry %s failures", async (ErrorClass, kind) => {
    const error = kind === "rate limit" ? new LLMRateLimitError() : new LLMNetworkError();
    const { gateway, provider } = gatewayWithError(error);
    await expect(consumeError(gateway)).rejects.toBeInstanceOf(ErrorClass);
    expect(provider.streamCallCount).toBe(1);
  });

  it("wraps unknown Error and thrown values as safe provider errors", async () => {
    const unknownError = new Error("Authorization: super-secret apiKey=abc");
    const first = gatewayWithError(unknownError);
    await expect(consumeError(first.gateway)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof LLMProviderError &&
        !error.message.includes("super-secret") &&
        !error.message.includes("apiKey")
      );
    });

    const second = gatewayWithError("boom");
    await expect(consumeError(second.gateway)).rejects.toBeInstanceOf(LLMProviderError);
    expect(second.provider.streamCallCount).toBe(1);
  });
});
