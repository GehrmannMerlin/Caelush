import * as protocol from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@caelush/protocol";

const requiredExports = [
  "AgentSessionSchema",
  "AgentRunSchema",
  "AgentStepSchema",
  "AgentStateSchema",
  "AgentEventSchema",
  "ToolDefinitionSchema",
  "ToolInvocationSchema",
  "ObservationSchema",
  "ApprovalRequestSchema",
  "VerificationResultSchema",
  "RunStatusSchema",
] as const;

function eventSummary(event: AgentEvent): string {
  switch (event.type) {
    case "shell.output":
      return event.payload.chunk;
    case "status.changed":
      return event.payload.to;
    default:
      return event.type;
  }
}

describe("protocol public API", () => {
  it("exports every Phase 1 contract schema from the package root", () => {
    for (const exportName of requiredExports) {
      expect(protocol[exportName], exportName).toBeDefined();
    }
  });

  it("keeps AgentEvent payload narrowing available to TypeScript consumers", () => {
    const eventSchema = protocol.AgentEventSchema;
    expect(eventSchema, "AgentEventSchema").toBeDefined();
    if (eventSchema === undefined) {
      return;
    }

    const event = eventSchema.parse({
      eventId: protocol.createEventId(),
      schemaVersion: 1,
      runId: protocol.createRunId(),
      sessionId: protocol.createSessionId(),
      type: "status.changed",
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      payload: { from: "RUNNING", to: "VERIFYING" },
    });

    expect(eventSummary(event)).toBe("VERIFYING");
  });
});
