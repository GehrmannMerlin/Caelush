import { describe, expect, it } from "vitest";
import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  MissingToolResultsError,
  TypeValidationError,
} from "ai";
import { AIError, createAIError } from "../../../src/errors/ai-error.js";
import { normalizeOpenAICompatibleError } from "../../../src/adapters/openai-compatible/error-normalizer.js";
import type { ModelRef } from "../../../src/models/model-ref.js";

const MODEL: ModelRef = { provider: "compat-fixture", model: "fixture-model" };
const SECRET = "fake-api-secret-123";

function apiError(input: {
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
  readonly data?: unknown;
  readonly message?: string;
}): APICallError {
  return new APICallError({
    message: input.message ?? "provider call failed",
    url: "http://127.0.0.1:4321/v1/chat/completions",
    requestBodyValues: { model: "fixture-model" },
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.responseHeaders === undefined ? {} : { responseHeaders: input.responseHeaders }),
    ...(input.responseBody === undefined ? {} : { responseBody: input.responseBody }),
    ...(input.data === undefined ? {} : { data: input.data }),
  });
}

function normalize(error: unknown): AIError {
  return normalizeOpenAICompatibleError(error, MODEL);
}

describe("OpenAI-compatible error normalization", () => {
  it("passes an existing AIError through unchanged", () => {
    const original = createAIError("AI_TIMEOUT", "already normalized");

    expect(normalize(original)).toBe(original);
  });

  it("maps 401 and 403 to authentication, not retryable", () => {
    for (const statusCode of [401, 403]) {
      const normalized = normalize(apiError({ statusCode }));

      expect(normalized.code).toBe("AI_AUTHENTICATION");
      expect(normalized.retryable).toBe(false);
      expect(normalized.providerId).toBe("compat-fixture");
      expect(normalized.model).toEqual(MODEL);
    }
  });

  it("maps 429 to rate limit, retryable", () => {
    const normalized = normalize(apiError({ statusCode: 429 }));

    expect(normalized.code).toBe("AI_RATE_LIMIT");
    expect(normalized.retryable).toBe(true);
  });

  it("maps retry-after to retryAfterMs without inventing a delay", () => {
    expect(
      normalize(apiError({ statusCode: 429, responseHeaders: { "retry-after": "2" } }))
        .retryAfterMs,
    ).toBe(2_000);
    expect(
      normalize(apiError({ statusCode: 429, responseHeaders: { "Retry-After": "1.5" } }))
        .retryAfterMs,
    ).toBe(1_500);
    expect(normalize(apiError({ statusCode: 429 })).retryAfterMs).toBeUndefined();
    expect(
      normalize(apiError({ statusCode: 429, responseHeaders: { "retry-after": "not-a-number" } }))
        .retryAfterMs,
    ).toBeUndefined();
    expect(
      normalize(apiError({ statusCode: 429, responseHeaders: { "retry-after": "-5" } }))
        .retryAfterMs,
    ).toBeUndefined();
  });

  it("maps other provider 4xx and 5xx to a non-retryable provider error", () => {
    for (const statusCode of [400, 404, 409, 422, 500, 502, 503]) {
      const normalized = normalize(apiError({ statusCode }));

      expect(normalized.code, String(statusCode)).toBe("AI_PROVIDER_ERROR");
      expect(normalized.retryable).toBe(false);
    }
  });

  it("maps a transport failure without a status code to network, retryable", () => {
    const normalized = normalize(apiError({}));

    expect(normalized.code).toBe("AI_NETWORK");
    expect(normalized.retryable).toBe(true);
  });

  it("detects an explicit native context-overflow code", () => {
    const normalized = normalize(
      apiError({
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { code: "context_length_exceeded", message: "too long" },
        }),
      }),
    );

    expect(normalized.code).toBe("AI_CONTEXT_OVERFLOW");
    expect(normalized.retryable).toBe(false);
  });

  it("detects an explicit native context-overflow code in structured data", () => {
    expect(
      normalize(apiError({ statusCode: 400, data: { error: { code: "context_length_exceeded" } } }))
        .code,
    ).toBe("AI_CONTEXT_OVERFLOW");
  });

  it("detects a high-confidence context length message", () => {
    expect(
      normalize(
        apiError({
          statusCode: 400,
          responseBody:
            "This model's maximum context length is 8192 tokens, however you requested more",
        }),
      ).code,
    ).toBe("AI_CONTEXT_OVERFLOW");
  });

  it("never maps every 400 to context overflow", () => {
    for (const responseBody of [
      JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }),
      JSON.stringify({ error: { message: "unknown model" } }),
      "invalid request body",
    ]) {
      const normalized = normalize(apiError({ statusCode: 400, responseBody }));

      expect(normalized.code, responseBody).toBe("AI_PROVIDER_ERROR");
    }
  });

  it("maps parse, validation and response-data failures to invalid response", () => {
    const errors = [
      new JSONParseError({ text: "{", cause: new Error("bad json") }),
      new TypeValidationError({ value: { a: 1 }, cause: new Error("bad type") }),
      new InvalidResponseDataError({ data: {}, message: "bad data" }),
    ];

    for (const error of errors) {
      const normalized = normalize(error);

      expect(normalized.code, error.name).toBe("AI_INVALID_RESPONSE");
      expect(normalized.retryable).toBe(false);
    }
  });

  it("maps an unknown throw to provider error and an Error to network", () => {
    expect(normalize(new Error("boom")).code).toBe("AI_NETWORK");
    expect(normalize("a string").code).toBe("AI_PROVIDER_ERROR");
    expect(normalize(undefined).code).toBe("AI_PROVIDER_ERROR");
    expect(normalize({ arbitrary: true }).code).toBe("AI_PROVIDER_ERROR");
  });

  it("never reports a prompt construction failure as a network failure", () => {
    // The provider is never contacted for a prompt the SDK refuses to build, so a
    // retryable network code would be actively misleading.
    try {
      throw new MissingToolResultsError({ toolCallIds: ["c1"] });
    } catch (error) {
      const normalized = normalize(error);

      expect(normalized.code).toBe("AI_INVALID_REQUEST");
      expect(normalized.retryable).toBe(false);
      expect(normalized.message).not.toContain("Tool result is missing");
    }
  });

  it("maps SDK configuration and capability errors onto the frozen set", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["AI_InvalidPromptError", "AI_INVALID_REQUEST"],
      ["AI_InvalidArgumentError", "AI_INVALID_REQUEST"],
      ["AI_InvalidMessageRoleError", "AI_INVALID_REQUEST"],
      ["AI_MessageConversionError", "AI_INVALID_REQUEST"],
      ["AI_MissingToolResultsError", "AI_INVALID_REQUEST"],
      ["AI_UnsupportedFunctionalityError", "AI_CAPABILITY_UNSUPPORTED"],
      ["AI_LoadAPIKeyError", "AI_AUTHENTICATION"],
      ["AI_NoSuchModelError", "AI_MODEL_UNSUPPORTED"],
      ["AI_EmptyResponseBodyError", "AI_INVALID_RESPONSE"],
      ["AI_StreamProviderError", "AI_PROVIDER_ERROR"],
    ];

    for (const [name, code] of cases) {
      const error = new Error("sdk failure");
      error.name = name;

      expect(normalize(error).code, name).toBe(code);
    }
  });

  it("never copies raw headers, bodies or credentials into the message", () => {
    const normalized = normalize(
      apiError({
        statusCode: 429,
        responseHeaders: { authorization: `Bearer ${SECRET}`, "retry-after": "3" },
        responseBody: `{"error":{"message":"key ${SECRET} rejected"}}`,
        message: `request failed with api_key=${SECRET}`,
      }),
    );

    const serialized = JSON.stringify({
      code: normalized.code,
      message: normalized.message,
      providerId: normalized.providerId,
      retryAfterMs: normalized.retryAfterMs,
    });

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("responseBody");
    expect(serialized).not.toContain("requestBodyValues");
  });

  it("keeps the original error internal as a cause", () => {
    const original = apiError({ statusCode: 500 });
    const normalized = normalize(original);

    expect(normalized.cause).toBe(original);
  });
});
