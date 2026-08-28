import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "@caelush/storage";
import { describe, expect, it } from "vitest";
import { toApiErrorResponse } from "../src/transport/error-handler.js";

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
    const mapped = toApiErrorResponse({ validation: [{ instancePath: "/title", keyword: "minLength" }] }, "req-456");
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("INVALID_REQUEST");
    expect(mapped.body.error.requestId).toBe("req-456");
  });
});
