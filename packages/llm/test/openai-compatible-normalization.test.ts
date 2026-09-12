import { describe, expect, it } from "vitest";
import {
  toLegacyStreamEvents,
  toLegacyStreamStart,
} from "../src/compatibility/stream-projection.js";
import { toLegacyLLMError } from "../src/compatibility/error-projection.js";
import {
  LLMAbortedError,
  LLMAuthenticationError,
  LLMContextOverflowError,
  LLMError,
  LLMInvalidRequestError,
  LLMInvalidResponseError,
  LLMModelUnsupportedError,
  LLMNetworkError,
  LLMProviderError,
  LLMProviderNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMCapabilityUnsupportedError,
} from "../src/errors.js";
import type { AIAdapterEvent, AIError, AIErrorCode } from "@caelush/ai";
import type { LLMCallId } from "@caelush/protocol";

/**
 * The finish-reason and usage normalisation themselves moved to
 * `@caelush/ai/adapters/openai-compatible`, where they are covered by
 * `packages/ai/test/adapters/openai-compatible/finish-reason.test.ts` and
 * `usage-normalizer.test.ts`.
 *
 * What this file locks is the projection back onto the legacy contract: the legacy
 * stream event shapes, the provider-native finish reason surviving into the legacy
 * finish event, and the AI error codes landing on the right legacy classes.
 */
const CONTEXT = {
  callId: "llm_0195f3a0-0000-7000-8000-000000000000" as LLMCallId,
  providerId: "compat-fixture",
  model: { provider: "compat-fixture", model: "fixture-model" },
};

function project(event: AIAdapterEvent) {
  return [...toLegacyStreamEvents(event)];
}

describe("OpenAI-compatible legacy stream projection", () => {
  it("projects the legacy stream.start envelope verbatim", () => {
    expect(toLegacyStreamStart(CONTEXT)).toEqual({
      type: "stream.start",
      payload: {
        callId: CONTEXT.callId,
        providerId: "compat-fixture",
        model: { provider: "compat-fixture", model: "fixture-model" },
      },
    });
  });

  it("projects text, tool lifecycle and usage events", () => {
    expect(project({ type: "text.delta", payload: { text: "hello" } })).toEqual([
      { type: "text.delta", payload: { text: "hello" } },
    ]);

    expect(
      project({ type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } }),
    ).toEqual([{ type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } }]);

    expect(
      project({ type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path"' } }),
    ).toEqual([{ type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path"' } }]);

    expect(
      project({
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      }),
    ).toEqual([
      {
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      },
    ]);

    expect(project({ type: "usage", payload: { inputTokens: 7 } })).toEqual([
      { type: "usage", payload: { inputTokens: 7 } },
    ]);
  });

  it("keeps every reported usage counter and never synthesizes one", () => {
    const [event] = project({
      type: "usage",
      payload: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      },
    });

    expect(event).toEqual({
      type: "usage",
      payload: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      },
    });

    expect(project({ type: "usage", payload: { inputTokens: 7 } })[0]).toEqual({
      type: "usage",
      payload: { inputTokens: 7 },
    });
  });

  it.each([
    ["STOP", "stop"],
    ["LENGTH", "length"],
    ["TOOL_CALLS", "tool-calls"],
    ["CONTENT_FILTER", "content-filter"],
    ["OTHER", "future-provider-value"],
  ] as const)("projects a %s finish reason unchanged", (finishReason, providerReason) => {
    expect(project({ type: "adapter.finish", payload: { finishReason, providerReason } })).toEqual([
      { type: "stream.finish", payload: { finishReason } },
    ]);
  });

  it("carries finalUsage onto the legacy finish event", () => {
    expect(
      project({
        type: "adapter.finish",
        payload: { finishReason: "STOP", finalUsage: { inputTokens: 4, totalTokens: 9 } },
      }),
    ).toEqual([
      {
        type: "stream.finish",
        payload: { finishReason: "STOP", finalUsage: { inputTokens: 4, totalTokens: 9 } },
      },
    ]);
  });

  it("never exposes a reasoning summary through the legacy stream", () => {
    // The legacy union has no reasoning member, and folding chain-of-thought into
    // `text.delta` would corrupt assistant content. It is dropped instead.
    expect(
      project({ type: "reasoning.summary.delta", payload: { text: "hidden thinking" } }),
    ).toEqual([]);
  });

  it("drops empty text deltas, which the legacy schema rejects", () => {
    expect(project({ type: "text.delta", payload: { text: "" } })).toEqual([]);
  });

  it("never emits a gateway envelope event from an adapter event", () => {
    const events: AIAdapterEvent[] = [
      { type: "text.delta", payload: { text: "x" } },
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "t" } },
      { type: "adapter.finish", payload: { finishReason: "STOP" } },
    ];

    const projected = events.flatMap((event) => project(event));

    // The legacy union has no `stream.error` member at all, so the projection cannot
    // produce one — the type checker proves it as well as this assertion does.
    const legacyTypes = new Set([
      "stream.start",
      "text.delta",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.completed",
      "usage",
      "stream.finish",
    ]);
    for (const event of projected) expect(legacyTypes.has(event.type)).toBe(true);

    expect(projected.filter((event) => event.type === "stream.start")).toEqual([]);
    expect(projected.filter((event) => event.type === "stream.finish")).toHaveLength(1);
  });
});

describe("OpenAI-compatible legacy error projection", () => {
  const CASES: readonly (readonly [AIErrorCode, new (...args: never[]) => LLMError])[] = [
    ["AI_PROVIDER_NOT_FOUND", LLMProviderNotFoundError],
    ["AI_MODEL_UNSUPPORTED", LLMModelUnsupportedError],
    ["AI_CAPABILITY_UNSUPPORTED", LLMCapabilityUnsupportedError],
    ["AI_INVALID_REQUEST", LLMInvalidRequestError],
    ["AI_AUTHENTICATION", LLMAuthenticationError],
    ["AI_RATE_LIMIT", LLMRateLimitError],
    ["AI_NETWORK", LLMNetworkError],
    ["AI_TIMEOUT", LLMTimeoutError],
    ["AI_CONTEXT_OVERFLOW", LLMContextOverflowError],
    ["AI_ABORTED", LLMAbortedError],
    ["AI_INVALID_RESPONSE", LLMInvalidResponseError],
    ["AI_PROVIDER_ERROR", LLMProviderError],
  ];

  it.each(CASES)("projects %s onto the matching legacy error class", (code, LegacyClass) => {
    const projected = toLegacyLLMError(aiError(code));

    // Class identity matters: existing consumers branch with `instanceof`.
    expect(projected).toBeInstanceOf(LegacyClass);
    expect(projected).toBeInstanceOf(LLMError);
    expect(projected).toBeInstanceOf(Error);
  });

  it("projects the two AI-only codes onto a safe legacy provider failure", () => {
    for (const code of ["AI_MODEL_METADATA_INCOMPLETE", "AI_ADAPTER_NOT_FOUND"] as AIErrorCode[]) {
      const projected = toLegacyLLMError(aiError(code));

      expect(projected, code).toBeInstanceOf(LLMError);
      expect(projected.code, code).not.toBe("LLM_INVALID_RESPONSE");
    }

    expect(toLegacyLLMError(aiError("AI_MODEL_METADATA_INCOMPLETE"))).toBeInstanceOf(
      LLMModelUnsupportedError,
    );
    expect(toLegacyLLMError(aiError("AI_ADAPTER_NOT_FOUND"))).toBeInstanceOf(LLMProviderError);
  });

  it("preserves provider, model, retryability and retryAfterMs", () => {
    const rateLimited = toLegacyLLMError({
      ...aiError("AI_RATE_LIMIT"),
      retryAfterMs: 2_000,
    } as AIError);

    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryAfterMs).toBe(2_000);
    expect(rateLimited.providerId).toBe("compat-fixture");
    expect(rateLimited.model).toEqual({ provider: "compat-fixture", model: "fixture-model" });

    expect(toLegacyLLMError(aiError("AI_AUTHENTICATION")).retryable).toBe(false);
  });

  it("does not carry raw error text into a legacy message", () => {
    const projected = toLegacyLLMError(aiError("AI_AUTHENTICATION"));

    expect(projected.message).not.toContain("upstream body");
    expect(JSON.stringify(projected.message)).not.toContain("cause");
  });

  it("keeps the original AI failure reachable as the cause", () => {
    const original = aiError("AI_NETWORK");

    expect(toLegacyLLMError(original).cause).toBe(original);
  });
});

/** Build an AI failure with the frozen shape for the given code. */
function aiError(code: AIErrorCode): AIError {
  return {
    name: "AIError",
    message: "ai failure",
    code,
    providerId: "compat-fixture",
    model: { provider: "compat-fixture", model: "fixture-model" },
    retryable: code === "AI_RATE_LIMIT" || code === "AI_NETWORK" || code === "AI_TIMEOUT",
    retryAfterMs: undefined,
  } as unknown as AIError;
}
