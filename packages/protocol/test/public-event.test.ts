import {
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  PublicRunEventSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId: createRunId(),
    sessionId: createSessionId(),
    type: "shell.output",
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload: {
      invocationId: createToolInvocationId(),
      stream: "stdout",
      chunk: "hello",
    },
    ...overrides,
  };
}

describe("PublicRunEvent protocol contract", () => {
  it("parses a registered USER_VISIBLE event", () => {
    const parsed = PublicRunEventSchema.safeParse(event());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.visibility).toBe("USER_VISIBLE");
      expect(parsed.data.type).toBe("shell.output");
    }
  });

  it.each(["DEBUG", "SYSTEM"] as const)("rejects %s visibility", (visibility) => {
    expect(PublicRunEventSchema.safeParse(event({ visibility })).success).toBe(false);
  });

  it("rejects an event type that the catalog marks DEBUG even if an instance claims USER_VISIBLE", () => {
    expect(
      PublicRunEventSchema.safeParse(
        event({
          type: "error",
          payload: {
            error: {
              code: "INTERNAL_ERROR",
              message: "safe error",
              retryable: false,
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(PublicRunEventSchema.safeParse(event({ type: "internal.secret" })).success).toBe(false);
  });

  it("rejects unsupported schema versions", () => {
    expect(PublicRunEventSchema.safeParse(event({ schemaVersion: 2 })).success).toBe(false);
  });

  it("rejects malformed payloads instead of accepting arbitrary public data", () => {
    expect(
      PublicRunEventSchema.safeParse(
        event({ payload: { invocationId: "not-an-id", stream: "stdout", chunk: 42 } }),
      ).success,
    ).toBe(false);
  });
});
