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
  it("maps only public model deltas onto canonical ordered transient events", () => {
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
    const toolCall = project.project({
      identity,
      stepId: turn.stepId,
      event: { type: "tool_call.delta", payload: { toolCallId: "call-1", delta: '{"path":' } },
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
    expect(toolCall).toMatchObject({
      type: "model.tool_call.delta",
      payload: { toolCallId: "call-1", delta: '{"path":' },
      durability: { streamSequence: 1 },
    });
    expect(
      new Set([text?.eventId, text2?.eventId, reasoning?.eventId, toolCall?.eventId]).size,
    ).toBe(4);
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
    expect(emitted).toHaveLength(2);
    expect(emitted).toMatchObject([
      { type: "model.text.delta", payload: { text: "answer" } },
      { type: "model.reasoning_summary.delta", payload: { text: "safe" } },
    ]);
  });

  const ignoredEvents = [
    { type: "stream.start", payload: { callId: "call" } },
    { type: "tool_call.start", payload: { toolCallId: "call", name: "read_file" } },
    { type: "tool_call.completed", payload: { toolCallId: "call", name: "read_file" } },
    { type: "usage", payload: { inputTokens: 1, outputTokens: 1 } },
    { type: "stream.finish", payload: { reason: "stop" } },
    { type: "stream.error", payload: { code: "AI_NETWORK", message: "safe" } },
  ] as unknown as AIStreamEvent[];

  it.each(ignoredEvents)("does not project $type", (event) => {
    expect(projector().project({ identity, stepId: turn.stepId, event })).toBeNull();
  });
});
