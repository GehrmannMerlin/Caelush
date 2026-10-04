import {
  AgentEventSchema,
  RUN_EVENT_SCHEMA_REGISTRY,
  RUN_EVENT_TYPE_CATALOG,
  PublicRunEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  ModelReasoningSummaryDeltaEventSchema,
  ModelStatusEventSchema,
  ModelTextDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
  ProcessOutputEventV2Schema,
  ShellOutputEventV2Schema,
  ToolOutputEventV2Schema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

function common(schemaVersion: number, durability: Record<string, unknown>) {
  return {
    eventId: createEventId(),
    schemaVersion,
    runId: createRunId(),
    sessionId: createSessionId(),
    stepId: createStepId(),
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE" as const,
    durability,
  };
}

function ordered(streamKey: string, streamSequence = 1): Record<string, unknown> {
  return {
    kind: "EPHEMERAL",
    version: 1,
    deliveryClass: "ORDERED",
    streamKey,
    streamSequence,
  };
}

describe("Phase 6E transient event contracts", () => {
  it("keeps durable v1 output history beside transient v2 output", () => {
    const invocationId = createToolInvocationId();
    const v1 = {
      ...common(1, { kind: "DURABLE", version: 1, sequence: 1 }),
      type: "tool.output",
      payload: { invocationId, stream: "stdout", chunk: "historical" },
    };
    const v2 = {
      ...common(2, ordered("tool:tinv", 1)),
      type: "tool.output",
      payload: { invocationId, stream: "stdout", chunk: "live" },
    };

    expect(AgentEventSchema.parse(v1)).toMatchObject({ schemaVersion: 1, type: "tool.output" });
    expect(ToolOutputEventV2Schema.parse(v2)).toMatchObject({
      schemaVersion: 2,
      durability: { deliveryClass: "ORDERED" },
    });
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("tool.output", 1)).toBe(true);
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("tool.output", 2)).toBe(true);
    expect(RUN_EVENT_SCHEMA_REGISTRY.parse(v2)).toMatchObject({ schemaVersion: 2 });
    expect(
      RUN_EVENT_TYPE_CATALOG.find(
        ({ type, schemaVersion }) => type === "tool.output" && schemaVersion === 1,
      )?.delivery,
    ).toEqual({ kind: "DURABLE" });
    expect(
      RUN_EVENT_TYPE_CATALOG.find(
        ({ type, schemaVersion }) => type === "tool.output" && schemaVersion === 2,
      )?.delivery,
    ).toEqual({ kind: "TRANSIENT", class: "ORDERED" });
  });

  it("registers canonical model delta events with minimal ordered payloads", () => {
    const base = common(1, ordered("model:text:run:step", 1));
    const text = ModelTextDeltaEventSchema.parse({
      ...base,
      type: "model.text.delta",
      payload: { text: "hi" },
    });
    const reasoning = ModelReasoningSummaryDeltaEventSchema.parse({
      ...base,
      eventId: createEventId(),
      durability: ordered("model:reasoning-summary:run:step", 1),
      type: "model.reasoning_summary.delta",
      payload: { text: "public summary" },
    });
    const tool = ModelToolCallDeltaEventSchema.parse({
      ...base,
      eventId: createEventId(),
      durability: ordered("model:tool-call:run:step:call", 1),
      type: "model.tool_call.delta",
      payload: { toolCallId: "call", delta: '{"path":' },
    });

    expect(text).toMatchObject({ type: "model.text.delta", payload: { text: "hi" } });
    expect(reasoning).toMatchObject({ type: "model.reasoning_summary.delta" });
    expect(tool).toMatchObject({ type: "model.tool_call.delta", payload: { toolCallId: "call" } });
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("model.text.delta", 1)).toBe(true);
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("model.reasoning_summary.delta", 1)).toBe(true);
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("model.tool_call.delta", 1)).toBe(true);
    expect(PublicRunEventSchema.parse(text)).toMatchObject({ type: "model.text.delta" });
  });

  it("registers bounded coalescible model status without arbitrary text", () => {
    const base = common(1, {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "COALESCIBLE",
      streamKey: "",
    });
    const status = ModelStatusEventSchema.parse({
      ...base,
      type: "model.status",
      durability: {
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "COALESCIBLE",
        streamKey: `model:status:${base.runId}:${base.stepId}`,
      },
      payload: {
        phase: "NO_RECENT_ACTIVITY",
        lastActivityAt: 1_700_000_000_000,
        idleForMs: 30_000,
        idleTimeoutMs: 300_000,
      },
    });

    expect(status).toMatchObject({ type: "model.status", visibility: "USER_VISIBLE" });
    expect(RUN_EVENT_SCHEMA_REGISTRY.parse(status)).toMatchObject({ type: "model.status" });
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("model.status", 1)).toBe(true);
    expect(
      RUN_EVENT_TYPE_CATALOG.find(({ type }) => type === "model.status"),
    ).toMatchObject({ visibility: "USER_VISIBLE", delivery: { kind: "TRANSIENT", class: "COALESCIBLE" } });
    expect(PublicRunEventSchema.parse(status)).toMatchObject({ type: "model.status" });

    expect(ModelStatusEventSchema.safeParse({ ...status, payload: { ...status.payload, message: "waiting" } }).success).toBe(false);
    expect(ModelStatusEventSchema.safeParse({
      ...status,
      durability: { ...status.durability, streamKey: "model:status:other:step" },
    }).success).toBe(false);
  });

  it("provides ordered v2 shell and process output without accepting incomplete metadata", () => {
    const invocationId = createToolInvocationId();
    const shell = {
      ...common(2, ordered("shell:tinv", 1)),
      type: "shell.output",
      payload: { invocationId, stream: "stderr", chunk: "warning" },
    };
    const process = {
      ...common(2, ordered("process:session-1", 1)),
      type: "process.output",
      payload: { processId: "session-1", stream: "stdout", chunk: "ready" },
    };

    expect(ShellOutputEventV2Schema.parse(shell)).toMatchObject({ schemaVersion: 2 });
    expect(ProcessOutputEventV2Schema.parse(process)).toMatchObject({ schemaVersion: 2 });
    expect(
      AgentEventSchema.safeParse({ ...shell, durability: { kind: "EPHEMERAL" } }).success,
    ).toBe(false);
  });
});
