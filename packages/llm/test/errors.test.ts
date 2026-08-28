import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import type {
  LLMCapabilities,
  LLMProvider,
  LLMProviderRequest,
  LLMStreamEvent,
} from "../src/index.js";
import {
  LLMAbortedError,
  LLMAuthenticationError,
  LLMCapabilityUnsupportedError,
  LLMError,
  LLMInvalidResponseError,
  LLMInvalidRequestError,
  LLMModelUnsupportedError,
  LLMNetworkError,
  LLMProviderError,
  LLMProviderNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
  ProviderIdSchema,
} from "../src/index.js";

const model = { provider: "local", model: "test-model" };
const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNSUPPORTED",
  reasoningSummary: "UNKNOWN",
};

describe("LLM errors and provider boundary", () => {
  it("provides a typed hierarchy with stable codes and safe context", () => {
    const errors = [
      new LLMProviderNotFoundError("missing"),
      new LLMModelUnsupportedError(model),
      new LLMCapabilityUnsupportedError("vision", model),
      new LLMAuthenticationError("credentials rejected", { providerId: "local" }),
      new LLMRateLimitError("slow down", { providerId: "local" }),
      new LLMNetworkError("connection failed", { providerId: "local" }),
      new LLMTimeoutError("request timed out", { providerId: "local" }),
      new LLMAbortedError("request aborted", { providerId: "local" }),
      new LLMInvalidResponseError("malformed response", { providerId: "local" }),
      new LLMInvalidRequestError("invalid request", { providerId: "local" }),
      new LLMProviderError("provider failed", { providerId: "local" }),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toMatch(/^LLM_/);
      expect(error.message).not.toContain("Authorization");
      expect(error.message).not.toContain("apiKey");
    }
    expect(errors[0]?.retryable).toBe(false);
    expect(errors[3]?.retryable).toBe(false);
    expect(errors[4]?.retryable).toBe(true);
    expect(errors[5]?.retryable).toBe(true);
    expect(errors[6]?.retryable).toBe(true);
    expect(errors[7]?.retryable).toBe(false);
  });

  it("validates provider ids and exposes the provider-turn interface", async () => {
    expect(ProviderIdSchema.safeParse("openai-compatible").success).toBe(true);
    expect(ProviderIdSchema.safeParse("OpenAI").success).toBe(false);
    expect(ProviderIdSchema.safeParse("1local").success).toBe(false);

    const event: LLMStreamEvent = {
      type: "stream.start",
      payload: { callId: createLLMCallId(), providerId: "local", model },
    };
    const provider: LLMProvider = {
      id: "local",
      supportsModel: (candidate) => candidate.provider === "local",
      getCapabilities: () => capabilities,
      async *stream(
        request: LLMProviderRequest,
        context: { callId: ReturnType<typeof createLLMCallId>; signal: AbortSignal },
      ): AsyncIterable<LLMStreamEvent> {
        void request;
        void context;
        yield event;
      },
    };

    expect(provider.supportsModel(model)).toBe(true);
    expect(provider.getCapabilities(model)).toEqual(capabilities);
    const streamed = [];
    for await (const value of provider.stream(
      { model, messages: [] },
      { callId: createLLMCallId(), signal: new AbortController().signal },
    )) {
      streamed.push(value);
    }
    expect(streamed).toEqual([event]);
  });
});
