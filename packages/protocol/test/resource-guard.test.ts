import {
  AgentEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  RunStatusSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Resource Guard protocol", () => {
  it("treats WAITING_RESOURCE as a non-terminal run status", () => {
    expect(RunStatusSchema.parse("WAITING_RESOURCE")).toBe("WAITING_RESOURCE");
  });

  it("parses a bounded durable resource guard event", () => {
    const event = AgentEventSchema.parse({
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "resource.guard",
      timestamp: 100,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      payload: {
        reason: "NO_PROGRESS",
        replanCount: 2,
        requestedToolCalls: 1,
      },
    });
    expect(event.type).toBe("resource.guard");
  });
});
