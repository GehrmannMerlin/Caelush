import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): SchemaLike | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as SchemaLike;
}

function getFactory(name: string): (() => string) | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as () => string;
}

describe("protocol AgentEvent", () => {
  it("exposes strict Phase 6A durability metadata contracts", () => {
    const ordered = getSchema("OrderedTransientEventMetaSchema");
    const coalescible = getSchema("CoalescibleTransientEventMetaSchema");
    const durable = getSchema("DurableRunEventMetaSchema");
    const version = getSchema("EventSchemaVersionSchema");
    if (
      ordered === undefined ||
      coalescible === undefined ||
      durable === undefined ||
      version === undefined
    ) {
      return;
    }

    expect(version.safeParse(1).success).toBe(true);
    expect(version.safeParse(0).success).toBe(false);
    expect(version.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(
      durable.safeParse({ kind: "DURABLE", version: 1, sequence: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
    expect(durable.safeParse({ kind: "DURABLE", version: 1 }).success).toBe(false);
    expect(durable.safeParse({ kind: "DURABLE", version: 1, sequence: 0 }).success).toBe(false);
    expect(
      durable.safeParse({ kind: "DURABLE", version: 1, sequence: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
    expect(
      ordered.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamKey: "model-turn",
        streamSequence: 1,
      }).success,
    ).toBe(true);
    expect(
      ordered.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamKey: "",
        streamSequence: 1,
      }).success,
    ).toBe(false);
    expect(
      ordered.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamKey: "model-turn",
      }).success,
    ).toBe(false);
    expect(
      ordered.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamKey: "model-turn",
        streamSequence: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      ordered.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamKey: "model-turn",
        streamSequence: 0,
      }).success,
    ).toBe(false);
    expect(
      coalescible.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "COALESCIBLE",
        streamKey: "tool-progress",
      }).success,
    ).toBe(true);
    expect(
      coalescible.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "COALESCIBLE",
        streamKey: "",
      }).success,
    ).toBe(false);
    expect(
      coalescible.safeParse({
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "COALESCIBLE",
      }).success,
    ).toBe(false);
  });

  it("uses one static type/version registry and catalog for current v1 events", () => {
    const registry = (protocol as Record<string, unknown>).RUN_EVENT_SCHEMA_REGISTRY as
      | { supports: (type: string, version: number) => boolean; parse: (value: unknown) => unknown }
      | undefined;
    const catalog = (protocol as Record<string, unknown>).RUN_EVENT_TYPE_CATALOG as
      | readonly { type: string; schemaVersion: number; visibility: string; delivery: unknown }[]
      | undefined;
    expect(registry).toBeDefined();
    expect(catalog).toBeDefined();
    if (registry === undefined || catalog === undefined) return;
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (createEventId === undefined || createRunId === undefined || createSessionId === undefined) {
      return;
    }

    expect(registry.supports("status.changed", 1)).toBe(true);
    expect(registry.supports("unknown.event", 1)).toBe(false);
    expect(registry.supports("status.changed", 2)).toBe(false);
    for (const definition of catalog) {
      expect(registry.supports(definition.type, definition.schemaVersion)).toBe(true);
    }
    expect(catalog.find(({ type }) => type === "tool.output")?.delivery).toEqual({
      kind: "DURABLE",
    });
    expect(
      registry.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId: createRunId(),
        sessionId: createSessionId(),
        timestamp: 1,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "status.changed",
        payload: { from: "RUNNING", to: "VERIFYING" },
      }),
    ).toMatchObject({ type: "status.changed" });
    expect(() => registry.parse({ type: "unknown.event", schemaVersion: 1 })).toThrow(
      /unsupported event type/i,
    );
    expect(() =>
      registry.parse({
        eventId: "evt_invalid",
        schemaVersion: 2,
        runId: "run_invalid",
        sessionId: "session_invalid",
        timestamp: 1,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "status.changed",
        payload: { from: "RUNNING", to: "VERIFYING" },
      }),
    ).toThrow(/unsupported event schema version/i);
    expect(() =>
      registry.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId: createRunId(),
        sessionId: createSessionId(),
        timestamp: 1,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "status.changed",
        payload: { wrong: true },
      }),
    ).toThrow(/invalid payload/i);
  });

  it("keeps current v1 ephemeral compatibility separate from canonical transient metadata", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const legacy = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "shell.output",
      timestamp: 1_700_000_000_000,
      visibility: "DEBUG",
      durability: { kind: "EPHEMERAL" },
      payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "legacy" },
    };
    expect(eventSchema.safeParse(legacy).success).toBe(true);
    expect(getSchema("TransientRunEventMetaSchema")?.safeParse(legacy.durability).success).toBe(
      false,
    );
  });

  it("parses a sanitized budget.exceeded event for each budget dimension", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined
    ) {
      return;
    }
    const common = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      type: "budget.exceeded",
    };
    expect(
      eventSchema.parse({
        ...common,
        payload: { dimension: "TOOL_CALLS", limit: 10, accounted: 10 },
      }),
    ).toMatchObject({ type: "budget.exceeded", payload: { dimension: "TOOL_CALLS" } });
    expect(
      eventSchema.parse({
        ...common,
        eventId: createEventId(),
        payload: { dimension: "TOKENS", limit: 100, accounted: 100 },
      }),
    ).toMatchObject({ payload: { dimension: "TOKENS" } });
    expect(
      eventSchema.parse({
        ...common,
        eventId: createEventId(),
        payload: { dimension: "COST", limitMicros: 2_500_000, accountedMicros: 2_500_000 },
      }),
    ).toMatchObject({ payload: { dimension: "COST" } });
  });

  it("parses strict retry scheduling and started events", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined
    ) {
      return;
    }
    const common = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1, sequence: 1 },
    };
    expect(
      eventSchema.parse({
        ...common,
        type: "retry.scheduled",
        payload: {
          attempt: 2,
          maxAttempts: 3,
          delayMs: 1_000,
          nextAttemptAt: 1_700_000_001_000,
          errorCode: "LLM_NETWORK",
        },
      }),
    ).toMatchObject({ type: "retry.scheduled" });
    expect(
      eventSchema.parse({
        ...common,
        eventId: createEventId(),
        type: "retry.started",
        payload: { attempt: 2, maxAttempts: 3 },
      }),
    ).toMatchObject({ type: "retry.started" });
  });
  it("parses a durable run.timed_out event with only deadline metadata", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined
    ) {
      return;
    }
    expect(
      eventSchema.safeParse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId: createRunId(),
        sessionId: createSessionId(),
        type: "run.timed_out",
        timestamp: 1_700_000_000_000,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        payload: { deadlineAt: 1_700_000_000_100 },
      }).success,
    ).toBe(true);
  });
  it("parses a durable lifecycle event with a positive authoritative sequence", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined
    ) {
      return;
    }

    const event = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "status.changed",
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      payload: { from: "RUNNING", to: "VERIFYING" },
    };

    expect(eventSchema.parse(event)).toEqual(event);
  });

  it("parses ephemeral output without inventing durable sequence metadata", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const event = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "shell.output",
      timestamp: 1_700_000_000_000,
      visibility: "DEBUG",
      durability: { kind: "EPHEMERAL" },
      payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "ok\n" },
    };

    expect(eventSchema.parse(event)).toEqual(event);
    expect(
      eventSchema.safeParse({ ...event, durability: { kind: "EPHEMERAL", sequence: 3 } }).success,
    ).toBe(false);
  });

  it("rejects mismatched payload discriminants, invalid durability, and unknown fields", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined
    ) {
      return;
    }

    const event = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "status.changed",
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      payload: { summary: "wrong payload" },
    };

    expect(eventSchema.safeParse(event).success).toBe(false);
    expect(eventSchema.safeParse({ ...event, typo: true }).success).toBe(false);
    expect(
      eventSchema.safeParse({ ...event, durability: { kind: "DURABLE", version: 1, sequence: 0 } })
        .success,
    ).toBe(false);
  });

  it("keeps raw tool arguments out of the user-visible tool.requested event", () => {
    const eventSchema = getSchema("AgentEventSchema");
    const createEventId = getFactory("createEventId");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      eventSchema === undefined ||
      createEventId === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const privateInvocation = {
      args: { apiKey: "CAELUSH_TOOL_SECRET_42" },
      startedAt: 1_700_000_000_001,
      finishedAt: 1_700_000_000_002,
    };
    const event = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: createRunId(),
      sessionId: createSessionId(),
      type: "tool.requested",
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      payload: {
        invocationId: createToolInvocationId(),
        toolName: "read_file",
        externalCallId: "external-1",
        riskLevel: "LOW",
      },
    };

    const parsed = eventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect(JSON.stringify(privateInvocation)).toContain("CAELUSH_TOOL_SECRET_42");
    expect(JSON.stringify(parsed)).not.toContain("CAELUSH_TOOL_SECRET_42");
    expect(JSON.stringify(parsed)).not.toContain("args");
    expect(JSON.stringify(parsed)).not.toContain("startedAt");
    expect(JSON.stringify(parsed)).not.toContain("finishedAt");
  });
});
