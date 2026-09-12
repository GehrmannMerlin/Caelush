import { describe, expect, it } from "vitest";
import {
  AI_ERROR_CODES,
  AI_ERROR_DEFAULT_MESSAGES,
  DEFAULT_AI_ERROR_RETRYABILITY,
} from "../src/errors/ai-error-code.js";
import { AIError, createAIError } from "../src/errors/ai-error.js";
import { createAIErrorSanitizer, redactSecrets } from "../src/errors/error-sanitizer.js";
import type { AIErrorCode } from "../src/errors/ai-error-code.js";
import type { AISerializableError } from "../src/errors/serializable-error.js";

const SECRET = "fake-api-secret-123";

const EXPECTED_RETRYABILITY: Record<AIErrorCode, boolean> = {
  AI_PROVIDER_NOT_FOUND: false,
  AI_MODEL_UNSUPPORTED: false,
  AI_MODEL_METADATA_INCOMPLETE: false,
  AI_ADAPTER_NOT_FOUND: false,
  AI_CAPABILITY_UNSUPPORTED: false,
  AI_INVALID_REQUEST: false,
  AI_AUTHENTICATION: false,
  AI_RATE_LIMIT: true,
  AI_NETWORK: true,
  AI_TIMEOUT: true,
  AI_CONTEXT_OVERFLOW: false,
  AI_ABORTED: false,
  AI_INVALID_RESPONSE: false,
  AI_PROVIDER_ERROR: false,
};

describe("AIErrorCode", () => {
  it("freezes exactly the fourteen codes", () => {
    expect(AI_ERROR_CODES).toEqual([
      "AI_PROVIDER_NOT_FOUND",
      "AI_MODEL_UNSUPPORTED",
      "AI_MODEL_METADATA_INCOMPLETE",
      "AI_ADAPTER_NOT_FOUND",
      "AI_CAPABILITY_UNSUPPORTED",
      "AI_INVALID_REQUEST",
      "AI_AUTHENTICATION",
      "AI_RATE_LIMIT",
      "AI_NETWORK",
      "AI_TIMEOUT",
      "AI_CONTEXT_OVERFLOW",
      "AI_ABORTED",
      "AI_INVALID_RESPONSE",
      "AI_PROVIDER_ERROR",
    ]);
  });

  it("exposes the frozen default retryability for every code", () => {
    expect(DEFAULT_AI_ERROR_RETRYABILITY).toEqual(EXPECTED_RETRYABILITY);
    for (const code of AI_ERROR_CODES) {
      expect(createAIError(code).retryable).toBe(EXPECTED_RETRYABILITY[code]);
    }
  });

  it("only treats rate limit, network and timeout as retryable", () => {
    const retryable = AI_ERROR_CODES.filter((code) => DEFAULT_AI_ERROR_RETRYABILITY[code]);

    expect(retryable).toEqual(["AI_RATE_LIMIT", "AI_NETWORK", "AI_TIMEOUT"]);
  });

  it("has a default message for every code", () => {
    for (const code of AI_ERROR_CODES) {
      expect(AI_ERROR_DEFAULT_MESSAGES[code].length).toBeGreaterThan(0);
      expect(createAIError(code).message).toBe(AI_ERROR_DEFAULT_MESSAGES[code]);
    }
  });
});

describe("AIError", () => {
  it("is an Error carrying the frozen public fields", () => {
    const error = createAIError("AI_RATE_LIMIT", "slow down", {
      providerId: "openai",
      model: { provider: "openai", model: "gpt-5" },
      retryAfterMs: 1_500,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AIError);
    expect(error.name).toBe("AIError");
    expect(error.code).toBe("AI_RATE_LIMIT");
    expect(error.message).toBe("slow down");
    expect(error.providerId).toBe("openai");
    expect(error.model).toEqual({ provider: "openai", model: "gpt-5" });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1_500);
  });

  it("keeps the cause internal to the Error object", () => {
    const cause = new Error(`upstream said ${SECRET}`);
    const error = createAIError("AI_PROVIDER_ERROR", "provider failed", { cause });

    expect(error.cause).toBe(cause);
    expect(createAIErrorSanitizer().sanitize(error)).not.toHaveProperty("cause");
  });

  it("rejects a malformed retryAfterMs", () => {
    for (const retryAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createAIError("AI_RATE_LIMIT", "x", { retryAfterMs })).toThrow(TypeError);
    }
  });
});

describe("AIErrorSanitizer", () => {
  it("produces a bounded serializable error", () => {
    const serialized = createAIErrorSanitizer().sanitize(
      createAIError("AI_TIMEOUT", "timed out", {
        providerId: "openai",
        model: { provider: "openai", model: "gpt-5" },
      }),
    );

    expect(serialized).toEqual({
      code: "AI_TIMEOUT",
      message: "timed out",
      providerId: "openai",
      model: { provider: "openai", model: "gpt-5" },
      retryable: true,
    });
  });

  it("never carries cause, stack, headers, credentials or raw bodies", () => {
    const error = createAIError("AI_AUTHENTICATION", "rejected", {
      cause: new Error("raw upstream body"),
    });
    const serialized = createAIErrorSanitizer().sanitize(error);

    expect(Object.keys(serialized).sort()).toEqual(["code", "message", "retryable"]);
    expect(serialized).not.toHaveProperty("stack");
    expect(serialized).not.toHaveProperty("cause");
  });

  it("keeps retryAfterMs only when it is present and valid", () => {
    const withDelay = createAIErrorSanitizer().sanitize(
      createAIError("AI_RATE_LIMIT", "slow down", { retryAfterMs: 0 }),
    );
    const withoutDelay = createAIErrorSanitizer().sanitize(
      createAIError("AI_RATE_LIMIT", "slow down"),
    );

    expect(withDelay.retryAfterMs).toBe(0);
    expect(withoutDelay).not.toHaveProperty("retryAfterMs");
  });

  it("redacts credential material in credential position", () => {
    const messages = [
      `request failed with ${SECRET}`,
      `request failed with Bearer ${SECRET}`,
      `request failed with x-api-key=${SECRET}`,
      `request failed with api_key=${SECRET}`,
      `request failed with token=${SECRET}`,
      `request failed with secret: ${SECRET}`,
      `request failed with Authorization: Bearer ${SECRET}`,
      `request failed with "api-key": "${SECRET}"`,
    ];

    for (const message of messages) {
      const serialized = createAIErrorSanitizer({
        knownSecrets: [SECRET],
      }).sanitize(createAIError("AI_AUTHENTICATION", message));

      expect(serialized.message).not.toContain(SECRET);
      expect(serialized.message).toContain("[REDACTED]");
    }
  });

  it("redacts credential material without being told the secret value", () => {
    const messages = [
      `request failed with Bearer ${SECRET}`,
      `request failed with x-api-key=${SECRET}`,
      `request failed with api_key=${SECRET}`,
      `request failed with token=${SECRET}`,
      `request failed with Authorization: Bearer ${SECRET}`,
    ];

    for (const message of messages) {
      const serialized = createAIErrorSanitizer().sanitize(
        createAIError("AI_AUTHENTICATION", message),
      );

      expect(serialized.message).not.toContain(SECRET);
    }
  });

  it("redacts known secrets wherever they appear", () => {
    const serialized = createAIErrorSanitizer({ knownSecrets: [SECRET] }).sanitize(
      createAIError("AI_PROVIDER_ERROR", `opaque ${SECRET} and ${SECRET} again`),
    );

    expect(serialized.message).not.toContain(SECRET);
    expect(serialized.message).toBe("opaque [REDACTED] and [REDACTED] again");
  });

  it("redacts provider-shaped tokens even without a keyword", () => {
    const serialized = createAIErrorSanitizer().sanitize(
      createAIError("AI_AUTHENTICATION", "key sk-abcdefghijklmnop1234 was rejected"),
    );

    expect(serialized.message).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("leaves ordinary diagnostics readable", () => {
    const message = 'model "gpt-5" is not registered for provider caf\u00e9-openai';

    expect(redactSecrets(message)).toBe(message);
  });

  it("ignores empty and useless known secrets", () => {
    expect(redactSecrets("plain text", ["", "a"])).toBe("plain text");
  });

  it("sanitizes a reconstructed error from a serializable error", () => {
    const serialized: AISerializableError = {
      code: "AI_NETWORK",
      message: "connection reset",
      retryable: true,
    };

    expect(
      createAIErrorSanitizer().sanitize(createAIError(serialized.code, serialized.message)),
    ).toEqual(serialized);
  });
});
