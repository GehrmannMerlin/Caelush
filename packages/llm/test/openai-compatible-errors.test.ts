import { describe, expect, it } from "vitest";
import {
  createOpenAICompatibleLLMProvider,
  LLMAbortedError,
  LLMAuthenticationError,
  LLMGateway,
  LLMInvalidResponseError,
  LLMNetworkError,
  LLMProviderError,
  LLMProviderRegistry,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../src/index.js";

const model = { provider: "local-openai", model: "demo-model" };
const secret = "CAELUSH_TEST_SECRET_DO_NOT_LEAK_42";

function createGateway(fetch: typeof globalThis.fetch) {
  const provider = createOpenAICompatibleLLMProvider({
    id: "local-openai",
    baseURL: "http://127.0.0.1:4321/v1",
    apiKey: secret,
    fetch,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: `failure ${secret}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI-compatible provider error normalization", () => {
  it.each([
    [401, LLMAuthenticationError],
    [403, LLMAuthenticationError],
    [429, LLMRateLimitError],
    [500, LLMProviderError],
    [503, LLMProviderError],
  ])("maps HTTP %s to a Caelush error without leaking credentials", async (status, ErrorType) => {
    const gateway = createGateway(async () => errorResponse(status));

    const error = await gateway
      .complete({ model, messages: [{ role: "user", content: "hello" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("maps a fetch rejection to a network error without exposing the raw error", async () => {
    const gateway = createGateway(async () => {
      throw new Error(`socket failed with ${secret}`);
    });

    const error = await gateway
      .complete({ model, messages: [{ role: "user", content: "hello" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMNetworkError);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("does not retry a rate-limited request", async () => {
    let requestCount = 0;
    const gateway = createGateway(async () => {
      requestCount += 1;
      return errorResponse(429);
    });

    await expect(
      gateway.complete({ model, messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(requestCount).toBe(1);
  });

  it("maps malformed upstream SSE data to an invalid-response error", async () => {
    const gateway = createGateway(
      async () =>
        new Response("data: invalid-json\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const error = await gateway
      .complete({ model, messages: [{ role: "user", content: "hello" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).not.toContain(secret);
  });

  it("forwards an external abort through the Gateway to the HTTP request", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const gateway = createGateway(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      resolveStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const operation = gateway.complete(
      { model, messages: [{ role: "user", content: "hello" }] },
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    const error = await operation.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMAbortedError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("lets the Gateway timeout abort the same HTTP request", async () => {
    let observedSignal: AbortSignal | undefined;
    const gateway = createGateway(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });

    const error = await gateway
      .complete({ model, messages: [{ role: "user", content: "hello" }] }, { timeoutMs: 15 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
  });
});
