import { describe, expect, it } from "vitest";
import { captureTurn } from "./support/harness.js";
import {
  capturingTransport,
  errorEvent,
  failingTransport,
  hangingTransport,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "../../support/anthropic-messages-transport.js";
import type { AIModelRequest } from "../../../src/request/model-request.js";

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "anthropic-fixture", model: "fixture-model" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

describe("Anthropic Messages HTTP error normalization", () => {
  it.each([
    [400, "AI_INVALID_REQUEST"],
    [401, "AI_AUTHENTICATION"],
    [403, "AI_AUTHENTICATION"],
    [404, "AI_INVALID_REQUEST"],
    [413, "AI_INVALID_REQUEST"],
    [422, "AI_INVALID_REQUEST"],
    [500, "AI_PROVIDER_ERROR"],
    [502, "AI_PROVIDER_ERROR"],
    [504, "AI_TIMEOUT"],
    [529, "AI_RATE_LIMIT"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const turn = await captureTurn(request(), { transport: failingTransport(status, "{}") });

    expect(turn.streamError?.code).toBe(code);
  });

  it.each([
    ["AI_INVALID_REQUEST", false],
    ["AI_AUTHENTICATION", false],
    ["AI_PROVIDER_ERROR", false],
    ["AI_TIMEOUT", true],
    ["AI_RATE_LIMIT", true],
  ] as const)("reports %s retryable=%s", async (code, retryable) => {
    const statusByCode: Record<string, number> = {
      AI_INVALID_REQUEST: 400,
      AI_AUTHENTICATION: 401,
      AI_PROVIDER_ERROR: 500,
      AI_TIMEOUT: 504,
      AI_RATE_LIMIT: 429,
    };
    const turn = await captureTurn(request(), {
      transport: failingTransport(statusByCode[code] as number, "{}"),
    });

    expect(turn.streamError?.code).toBe(code);
    expect(turn.streamError?.retryable).toBe(retryable);
  });

  it("maps a transient 429 with retry-after to retryAfterMs", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(429, '{"type":"error"}', { "retry-after": "3" }),
    });

    expect(turn.streamError?.code).toBe("AI_RATE_LIMIT");
    expect(turn.streamError?.retryable).toBe(true);
    expect(turn.streamError?.retryAfterMs).toBe(3_000);
  });

  it("leaves retryAfterMs absent for an unparsable retry-after", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(429, "{}", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    });

    expect(turn.streamError?.code).toBe("AI_RATE_LIMIT");
    expect(turn.streamError?.retryAfterMs).toBeUndefined();
  });

  it("maps a spend-cap 429 to a non-retryable provider error", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(
        429,
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "You have exceeded your spend limit." },
        }),
      ),
    });

    expect(turn.streamError?.code).toBe("AI_PROVIDER_ERROR");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("maps a usage-cap 429 to a non-retryable provider error", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(
        429,
        '{"error":{"message":"usage cap reached for this workspace"}}',
      ),
    });

    expect(turn.streamError?.code).toBe("AI_PROVIDER_ERROR");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("never reports HTTP 413 as a context overflow", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(413, '{"error":{"message":"request entity too large"}}'),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_REQUEST");
    expect(turn.streamError?.code).not.toBe("AI_CONTEXT_OVERFLOW");
  });

  it("maps a generic 400 to an invalid request, never to a context overflow", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(400, '{"error":{"type":"invalid_request_error"}}'),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_REQUEST");
  });

  it("maps an explicit native context-overflow error to AI_CONTEXT_OVERFLOW", async () => {
    const turn = await captureTurn(request(), {
      transport: failingTransport(
        400,
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens" },
        }),
      ),
    });

    expect(turn.streamError?.code).toBe("AI_CONTEXT_OVERFLOW");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("maps a network failure to AI_NETWORK", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => Promise.reject(new Error("socket closed"))),
    });

    expect(turn.streamError?.code).toBe("AI_NETWORK");
    expect(turn.streamError?.retryable).toBe(true);
  });

  it("maps an aborted request to the gateway's timeout code, never to AI_NETWORK", async () => {
    // The gateway owns abort semantics: a hanging transport is aborted by the
    // invocation timeout, and the adapter's own abort mapping is a backstop for the
    // case where the signal fired but the transport reported a raw error.
    const turn = await captureTurn(request(), {
      transport: hangingTransport(),
      timeoutMs: 40,
    });

    expect(turn.streamError?.code).toBe("AI_TIMEOUT");
    expect(turn.streamError?.code).not.toBe("AI_NETWORK");
  });

  it("maps an abort observed by the transport to AI_ABORTED, not AI_NETWORK", async () => {
    // The gateway owns abort semantics, but a transport can still surface the abort
    // as its own error. The adapter's backstop must not relabel that as a retryable
    // network failure.
    const controller = new AbortController();
    const transport = capturingTransport(async (captured) => {
      controller.abort();
      await Promise.resolve();
      if (captured.signalAborted()) throw new Error("The operation was aborted");
      throw new Error("not aborted");
    });

    const turn = await captureTurn(request(), {
      transport,
      timeoutMs: 200,
      signal: controller.signal,
    });

    expect(turn.streamError?.code).toBe("AI_ABORTED");
    expect(turn.streamError?.retryable).toBe(false);
    expect(turn.transportAttempts).toBe(1);
  });

  it("keeps every provider body out of the public error", async () => {
    const secretBody = '{"error":{"message":"key sk-ant-should-never-surface"}}';
    const turn = await captureTurn(request(), {
      transport: failingTransport(401, secretBody),
    });

    const serialized = JSON.stringify(turn.events);
    expect(serialized).not.toContain("sk-ant-should-never-surface");
    expect(serialized).not.toContain("invalid_request_error");
  });

  it("makes exactly one transport attempt for every HTTP failure", async () => {
    for (const status of [400, 401, 403, 413, 429, 500, 504, 529]) {
      const turn = await captureTurn(request(), { transport: failingTransport(status, "{}") });
      expect(turn.transportAttempts, String(status)).toBe(1);
    }
  });

  it("makes exactly one transport attempt for a network failure", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => Promise.reject(new Error("boom"))),
    });

    expect(turn.transportAttempts).toBe(1);
  });
});

describe("Anthropic Messages mid-stream error events", () => {
  it.each([
    ["authentication_error", "AI_AUTHENTICATION", false],
    ["permission_error", "AI_AUTHENTICATION", false],
    ["rate_limit_error", "AI_RATE_LIMIT", true],
    ["overloaded_error", "AI_RATE_LIMIT", true],
    ["timeout_error", "AI_TIMEOUT", true],
    ["request_too_large", "AI_INVALID_REQUEST", false],
    ["invalid_request_error", "AI_INVALID_REQUEST", false],
    ["api_error", "AI_PROVIDER_ERROR", false],
    ["a_future_error_type", "AI_PROVIDER_ERROR", false],
  ] as const)("maps the native error type %s to %s", async (type, code, retryable) => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([messageStart(), errorEvent(type, "native failure")]),
      ),
    });

    expect(turn.streamError?.code).toBe(code);
    expect(turn.streamError?.retryable).toBe(retryable);
  });

  it("maps a native context-overflow message pattern to AI_CONTEXT_OVERFLOW", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([
          messageStart(),
          errorEvent("invalid_request_error", "prompt is too long for this model"),
        ]),
      ),
    });

    expect(turn.streamError?.code).toBe("AI_CONTEXT_OVERFLOW");
  });

  it("never maps a generic native error to AI_CONTEXT_OVERFLOW", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([messageStart(), errorEvent("api_error")]),
      ),
    });

    expect(turn.streamError?.code).toBe("AI_PROVIDER_ERROR");
  });

  it("keeps the native error message out of the public error", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([messageStart(), errorEvent("api_error", "internal trace id 12345")]),
      ),
    });

    expect(JSON.stringify(turn.events)).not.toContain("internal trace id 12345");
  });
});

describe("Anthropic Messages mid-stream failure after text", () => {
  it("emits text then exactly one terminal stream.error", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([
          messageStart(),
          textBlockStart(0),
          textDelta(0, "partial answer"),
          errorEvent("overloaded_error"),
        ]),
      ),
    });

    expect(turn.events[0]?.type).toBe("stream.start");
    expect(turn.events.filter((event) => event.type === "text.delta")).toHaveLength(1);
    expect(turn.events.filter((event) => event.type === "stream.error")).toHaveLength(1);
    expect(turn.events.at(-1)?.type).toBe("stream.error");
  });

  it("never yields a finish event for a broken stream", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([
          messageStart(),
          textBlockStart(0),
          textDelta(0, "partial"),
          messageDelta("end_turn"),
        ]),
      ),
    });

    expect(turn.events.some((event) => event.type === "stream.finish")).toBe(false);
    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });
});

function sseResponseFor(
  events: readonly { event: string; data: Record<string, unknown> }[],
): Response {
  return new Response(
    events
      .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("Anthropic Messages stream termination", () => {
  it("completes a normal turn so the fixtures themselves are sound", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() =>
        sseResponseFor([
          messageStart(),
          textBlockStart(0),
          textDelta(0, "ok"),
          blockStop(0),
          messageDelta("end_turn"),
          messageStop(),
        ]),
      ),
    });

    expect(turn.streamError).toBeUndefined();
    expect(turn.events.at(-1)?.type).toBe("stream.finish");
  });
});
