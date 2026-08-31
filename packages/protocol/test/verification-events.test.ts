import {
  AgentEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Phase 11A verification planned event", () => {
  it("accepts only the bounded durable planning summary", () => {
    const event = {
      eventId: createEventId(),
      schemaVersion: 1 as const,
      runId: createRunId(),
      sessionId: createSessionId(),
      stepId: createStepId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 1 },
      type: "verification.planned" as const,
      payload: {
        planId: createVerificationPlanId(),
        sourceStepId: createStepId(),
        checkCount: 3,
        plannerVersion: "phase-11a.v1",
        counts: { required: 2, ifAvailable: 1, advisory: 0 },
      },
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(
      AgentEventSchema.safeParse({ ...event, payload: { ...event.payload, goal: "secret" } })
        .success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, counts: { ...event.payload.counts, commands: ["pnpm test"] } },
      }).success,
    ).toBe(false);
  });
});
