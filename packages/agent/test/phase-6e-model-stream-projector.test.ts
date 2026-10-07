import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
} from "@caelush/protocol";
import type { AIGateway, AIStreamEvent } from "@caelush/ai";
import type { AgentExecutionIdentity, AgentTurnRef } from "../src/loop/types.js";
import {
  createModelStreamSignalProjector,
  type ModelStreamSignalProjector,
} from "../src/events/model-stream-signal-projector.js";
import { createModelTurnExecutor } from "../src/loop/turn/model-turn-executor.js";
import { describe, expect, it } from "vitest";

const identity: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "test",
};
const turn: AgentTurnRef = { stepId: createStepId(), sequence: 3 };

function projector(): ModelStreamSignalProjector {
  return createModelStreamSignalProjector({
    eventIdFactory: { create: createEventId },
    clock: { now: () => createTimestampMs(1_700_000_000_000) },
  });
}

describe("ModelStreamSignalProjector", () => {
  it("maps model Tool starts to safe preparation metadata and suppresses argument deltas", () => {
    const project = projector();
    const text = project.project({
      identity,
      stepId: turn.stepId,
      event: { type: "text.delta", payload: { text: "Hel" } },
    });
    const text2 = project.project({
      identity,
      stepId: turn.stepId,
      event: { type: "text.delta", payload: { text: "lo" } },
    });
    const reasoning = project.project({
      identity,
      stepId: turn.stepId,
      event: { type: "reasoning.summary.delta", payload: { text: "safe summary" } },
    });
    const toolPreparation = project.project({
      identity,
      stepId: turn.stepId,
      event: {
        type: "tool_call.start",
        payload: { toolCallId: "call-1", toolName: "apply_patch" },
      },
    });
    const toolArguments = project.project({
      identity,
      stepId: turn.stepId,
      event: {
        type: "tool_call.delta",
        payload: { toolCallId: "call-1", delta: '{"patch":"*** Begin Patch\\nsecret-value' },
      },
    });

    expect(text).toMatchObject({
      type: "model.text.delta",
      runId: identity.runId,
      sessionId: identity.sessionId,
      stepId: turn.stepId,
      payload: { text: "Hel" },
      durability: {
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "ORDERED",
        streamSequence: 1,
      },
    });
    expect(text2).toMatchObject({
      type: "model.text.delta",
      durability: { streamSequence: 2 },
    });
    expect(reasoning).toMatchObject({
      type: "model.reasoning_summary.delta",
      payload: { text: "safe summary" },
      durability: { streamSequence: 1 },
    });
    expect(toolPreparation).toMatchObject({
      type: "model.tool_call.started",
      payload: { toolCallId: "call-1", toolName: "apply_patch" },
      durability: { streamSequence: 1 },
    });
    expect(toolArguments).toBeNull();
    expect(JSON.stringify(toolPreparation)).not.toContain("secret-value");
    expect(
      new Set([text?.eventId, text2?.eventId, reasoning?.eventId, toolPreparation?.eventId]).size,
    ).toBe(4);
  });

  it("keeps presentation bounded for 20 KiB and 100 KiB tool argument streams", () => {
    const project = projector();
    const preparation = project.project({
      identity,
      stepId: turn.stepId,
      event: {
        type: "tool_call.start",
        payload: { toolCallId: "call-large", toolName: "apply_patch" },
      },
    });
    const projections = [
      project.projectMany?.({
        identity,
        stepId: turn.stepId,
        event: {
          type: "tool_call.delta",
          payload: { toolCallId: "call-large", delta: "x".repeat(20 * 1024) },
        },
      }) ?? [],
      project.projectMany?.({
        identity,
        stepId: turn.stepId,
        event: {
          type: "tool_call.delta",
          payload: { toolCallId: "call-large", delta: "secret-value-123" + "y".repeat(100 * 1024) },
        },
      }) ?? [],
    ];
    const visibleEvents = [preparation, ...projections.flat()].filter(
      (event): event is NonNullable<typeof event> => event !== null,
    );
    const presentation = JSON.stringify(visibleEvents);

    expect(visibleEvents).toHaveLength(1);
    expect(Buffer.byteLength(presentation, "utf8")).toBeLessThan(1_024);
    expect(presentation).toContain("apply_patch");
    expect(presentation).not.toContain("secret-value-123");
    expect(presentation).not.toContain("x".repeat(20 * 1024));
    expect(presentation).not.toContain("y".repeat(100 * 1024));
  });

  it("maps model status onto a fixed coalescible run/step stream", () => {
    const status = projector().project({
      identity,
      stepId: turn.stepId,
      event: {
        type: "stream.status",
        payload: {
          phase: "NO_RECENT_ACTIVITY",
          lastActivityAt: 1_700_000_000_000,
          idleForMs: 30_000,
          idleTimeoutMs: 300_000,
        },
      },
    });

    expect(status).toMatchObject({
      type: "model.status",
      runId: identity.runId,
      sessionId: identity.sessionId,
      stepId: turn.stepId,
      visibility: "USER_VISIBLE",
      durability: {
        kind: "EPHEMERAL",
        version: 1,
        deliveryClass: "COALESCIBLE",
        streamKey: `model:status:${identity.runId}:${turn.stepId}`,
      },
      payload: {
        phase: "NO_RECENT_ACTIVITY",
        lastActivityAt: 1_700_000_000_000,
        idleForMs: 30_000,
        idleTimeoutMs: 300_000,
      },
    });
  });

  it("emits canonical transient signals from the executor without changing the assembled result", async () => {
    const emitted: unknown[] = [];
    const start: AIStreamEvent = {
      type: "stream.start",
      payload: {
        callId: "llm_0195f3a0-0000-7000-8000-000000000000" as never,
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture" },
        resolution: {} as never,
      },
    };
    const gateway: AIGateway = {
      stream: async () => ({
        callId: "llm_0195f3a0-0000-7000-8000-000000000000" as never,
        events: (async function* () {
          yield start;
          yield { type: "text.delta", payload: { text: "answer" } } satisfies AIStreamEvent;
          yield {
            type: "tool_call.start",
            payload: { toolCallId: "call-safe", toolName: "apply_patch" },
          } satisfies AIStreamEvent;
          yield {
            type: "tool_call.delta",
            payload: { toolCallId: "call-safe", delta: '{"patch":"*** Begin Patch secret-value' },
          } satisfies AIStreamEvent;
          yield {
            type: "tool_call.completed",
            payload: { id: "call-safe", name: "apply_patch", input: {} },
          } satisfies AIStreamEvent;
          yield {
            type: "stream.status",
            payload: {
              phase: "NO_RECENT_ACTIVITY",
              lastActivityAt: 1_700_000_000_000,
              idleForMs: 30_000,
              idleTimeoutMs: 300_000,
            },
          } satisfies AIStreamEvent;
          yield {
            type: "reasoning.summary.delta",
            payload: { text: "safe" },
          } satisfies AIStreamEvent;
          yield { type: "usage", payload: { inputTokens: 1 } } satisfies AIStreamEvent;
          yield {
            type: "stream.finish",
            payload: { finishReason: "STOP" },
          } satisfies AIStreamEvent;
        })(),
      }),
      complete: async () => {
        throw new Error("complete must not be called");
      },
    };
    const executor = createModelTurnExecutor({
      gateway,
      notifier: { notifyCommitted: () => undefined, emitTransient: (event) => emitted.push(event) },
      eventIdFactory: { create: createEventId },
      clock: { now: () => createTimestampMs(1_700_000_000_000) },
    });

    const result = await executor.execute({
      identity,
      turn,
      request: {
        model: { provider: "fixture", model: "fixture" },
        messages: [{ role: "user", content: "hello" }],
      },
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe("COMPLETED");
    expect((result as { kind: "COMPLETED"; result: { text: string } }).result.text).toBe("answer");
    expect(emitted).toHaveLength(4);
    expect(emitted).toMatchObject([
      { type: "model.text.delta", payload: { text: "answer" } },
      {
        type: "model.tool_call.started",
        payload: { toolCallId: "call-safe", toolName: "apply_patch" },
      },
      {
        type: "model.status",
        payload: { phase: "NO_RECENT_ACTIVITY", idleForMs: 30_000, idleTimeoutMs: 300_000 },
      },
      { type: "model.reasoning_summary.delta", payload: { text: "safe" } },
    ]);
    expect(JSON.stringify(emitted)).not.toContain("*** Begin Patch");
    expect(JSON.stringify(emitted)).not.toContain("secret-value");
    expect(
      (result as { kind: "COMPLETED"; result: { toolCalls: readonly unknown[] } }).result.toolCalls,
    ).toHaveLength(1);
  });

  const ignoredEvents = [
    { type: "stream.start", payload: { callId: "call" } },
    { type: "tool_call.completed", payload: { toolCallId: "call", name: "read_file" } },
    { type: "usage", payload: { inputTokens: 1, outputTokens: 1 } },
    { type: "stream.finish", payload: { reason: "stop" } },
    { type: "stream.error", payload: { code: "AI_NETWORK", message: "safe" } },
  ] as unknown as AIStreamEvent[];

  it.each(ignoredEvents)("does not project $type", (event) => {
    expect(projector().project({ identity, stepId: turn.stepId, event })).toBeNull();
  });
});
