import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "@caelush/storage";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandling, toApiErrorResponse } from "../src/transport/error-handler.js";
import { EventCursorAheadError } from "../src/events/run-event-hub.js";

describe("daemon error mapping", () => {
  it.each([
    [new Error("validation"), 500, "INTERNAL_ERROR"],
    [new StorageNotFoundError("AgentSession", "ses_secret"), 404, "NOT_FOUND"],
    [new StorageConflictError("duplicate secret"), 409, "CONFLICT"],
    [new StorageDecodeError("AgentSession", "ses_secret", "agent_sessions"), 500, "STORAGE_ERROR"],
    [new StorageError("database secret path"), 500, "STORAGE_ERROR"],
  ])("maps %s to %s %s", (error, statusCode, code) => {
    const mapped = toApiErrorResponse(error, "req-123");
    expect(mapped.statusCode).toBe(statusCode);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.body.error.requestId).toBe("req-123");
    expect(JSON.stringify(mapped.body)).not.toContain("secret");
    expect(JSON.stringify(mapped.body)).not.toContain("database");
  });

  it("maps validation-shaped errors to INVALID_REQUEST", () => {
    const mapped = toApiErrorResponse(
      { validation: [{ instancePath: "/title", keyword: "minLength" }] },
      "req-456",
    );
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("INVALID_REQUEST");
    expect(mapped.body.error.requestId).toBe("req-456");
  });

  it("maps malformed event query cursors to INVALID_EVENT_CURSOR", () => {
    const mapped = toApiErrorResponse(
      {
        validationContext: "querystring",
        validation: [{ instancePath: "/afterSequence", keyword: "invalid_type" }],
      },
      "req-789",
    );
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("INVALID_EVENT_CURSOR");
  });

  it("maps a cursor ahead of the fixed high watermark explicitly", () => {
    const mapped = toApiErrorResponse(
      new EventCursorAheadError("run_00000000-0000-7000-8000-000000000000" as never, 3, 2),
      "req-900",
    );
    expect(mapped.statusCode).toBe(409);
    expect(mapped.body.error.code).toBe("EVENT_CURSOR_AHEAD");
  });

  /**
   * A malformed request is a 400, not the anonymous 500.
   *
   * Fastify's request-parsing failures carry their own `statusCode` and no product error class, so they
   * used to fall through every branch to `500 INTERNAL_ERROR "An internal error occurred."` — the one
   * answer an operator cannot act on and a client cannot correct. The reproduction that matters is the
   * real HTTP surface: a bodyless action POST that still advertises `application/json`.
   */
  it.each([
    [
      'FST_ERR_CTP_EMPTY_JSON_BODY (400)',
      {
        code: "FST_ERR_CTP_EMPTY_JSON_BODY",
        statusCode: 400,
        message: "Body cannot be empty when content-type is set to 'application/json'",
      },
    ],
    [
      "FST_ERR_CTP_INVALID_MEDIA_TYPE (415)",
      {
        code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
        statusCode: 415,
        message: "Unsupported Media Type: text/secrecy",
      },
    ],
    [
      "FST_ERR_CTP_BODY_TOO_LARGE (413)",
      { code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413, message: "Request body is too large" },
    ],
  ])("maps a framework client error %s to 400 INVALID_REQUEST", (_label, error) => {
    const mapped = toApiErrorResponse(error, "req-1000");
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("INVALID_REQUEST");
    expect(mapped.body.error.message).toBe("The request is invalid.");
    // The framework's own message can quote the offending body, so it must never be echoed back.
    expect(JSON.stringify(mapped.body)).not.toContain("Body cannot be empty");
    expect(JSON.stringify(mapped.body)).not.toContain("Unsupported Media Type");
    expect(JSON.stringify(mapped.body)).not.toContain("too large");
  });

  it.each([
    ["a genuine server fault carrying 500", { statusCode: 500, message: "serializer exploded" }],
    ["a status outside the client range", { statusCode: 200, message: "nonsense status" }],
    ["a fractional status", { statusCode: 400.5, message: "nonsense status" }],
    ["a non-numeric status", { statusCode: "400", message: "nonsense status" }],
  ])("does not claim %s as a client error", (_label, error) => {
    const mapped = toApiErrorResponse(error, "req-1001");
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("answers a bodyless application/json action POST as 400, never as an anonymous 500", async () => {
    const app = fastify();
    registerErrorHandling(app);
    app.post("/api/v1/runs/:runId/recover", async () => ({ ok: true }));
    await app.ready();
    try {
      const malformed = await app.inject({
        method: "POST",
        url: "/api/v1/runs/run_x/recover",
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error.code).toBe("INVALID_REQUEST");

      // The supported shapes for a bodyless action stay successful: no content type at all, and an
      // explicit empty object. The defect was the classification, not the route.
      for (const request of [
        { method: "POST" as const, url: "/api/v1/runs/run_x/recover", headers: { accept: "application/json" } },
        { method: "POST" as const, url: "/api/v1/runs/run_x/recover", payload: {} },
      ]) {
        const accepted = await app.inject(request);
        expect(accepted.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
