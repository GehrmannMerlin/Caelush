import * as protocol from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@caelush/protocol";

/**
 * The Protocol contract schemas every consumer resolves from the package root.
 *
 * Phase 4F retired `ToolDefinitionSchema` from this list with the contract itself. The durable Tool
 * primitives it sat beside — a Tool's name, its invocation and that invocation's statuses — are still
 * here, because they are what a persisted row and an approval identity actually store.
 */
const requiredExports = [
  "AgentSessionSchema",
  "AgentRunSchema",
  "AgentStepSchema",
  "AgentStateSchema",
  "AgentEventSchema",
  "RunEventSchema",
  "EventSchemaVersionSchema",
  "DurableRunEventMetaSchema",
  "OrderedTransientEventMetaSchema",
  "CoalescibleTransientEventMetaSchema",
  "RUN_EVENT_SCHEMA_REGISTRY",
  "RUN_EVENT_TYPE_CATALOG",
  "ToolNameSchema",
  "ToolInvocationSchema",
  "ToolInvocationStatusSchema",
  "ObservationSchema",
  "ApprovalRequestSchema",
  "VerificationResultSchema",
  "RunStatusSchema",
] as const;

/** Names the retirement removed. A reappearing export would be a second Tool contract. */
const retiredExports = ["ToolDefinitionSchema", "ToolDefinition"] as const;

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

  it("no longer exports the retired legacy ToolDefinition contract", () => {
    for (const exportName of retiredExports) {
      expect(Object.hasOwn(protocol, exportName), exportName).toBe(false);
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
