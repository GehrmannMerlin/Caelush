import {
  AgentEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
  createVerificationCheckId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Phase 11A verification planned event", () => {
  it("accepts repair lifecycle events with bounded references", () => {
    const common = {
      eventId: createEventId(),
      schemaVersion: 1 as const,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 1 },
    };
    const event = {
      ...common,
      type: "verification.repair.started" as const,
      payload: {
        failedPlanId: createVerificationPlanId(),
        failedCheckIds: [createVerificationCheckId()],
        repairCycle: 1,
      },
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(
      AgentEventSchema.safeParse({
        ...event,
        type: "verification.repair.limit_reached",
        payload: {
          planId: createVerificationPlanId(),
          attemptedRepairs: 3,
          maxAutoRepairs: 3,
        },
      }).success,
    ).toBe(true);
  });
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

  it("accepts a bounded verification finalized event without raw evidence", () => {
    const event = {
      eventId: createEventId(),
      schemaVersion: 1 as const,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 3 },
      type: "verification.finalized" as const,
      payload: {
        planId: createVerificationPlanId(),
        outcome: "PASSED" as const,
        sealHash: "a".repeat(64),
        failedCheckIds: [],
        errorCheckIds: [],
      },
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(
      AgentEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, evidence: { stdout: "secret" } },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded check start and completion events", () => {
    const common = {
      eventId: createEventId(),
      schemaVersion: 1 as const,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 2 },
    };
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    const started = {
      ...common,
      type: "verification.check.started" as const,
      payload: {
        planId,
        checkId,
        ordinal: 0,
        kind: "PROJECT" as const,
        purpose: "LINT" as const,
        stage: "FAST_STATIC" as const,
      },
    };
    const completed = {
      ...common,
      eventId: createEventId(),
      type: "verification.check.completed" as const,
      payload: {
        planId,
        checkId,
        status: "PASSED" as const,
        evidenceIds: ["vevd_0190f2e9-9f5d-7f7a-8cf3-0f0b4a0c15d0"],
        durationMs: 125,
      },
    };

    expect(AgentEventSchema.parse(started)).toEqual(started);
    expect(AgentEventSchema.parse(completed)).toEqual(completed);
    expect(
      AgentEventSchema.safeParse({
        ...started,
        payload: { ...started.payload, command: "pnpm test" },
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        ...completed,
        payload: { ...completed.payload, stdout: "secret" },
      }).success,
    ).toBe(false);
  });
});
