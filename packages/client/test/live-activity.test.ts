import {
  PublicRunEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  createInitialLiveActivityState,
  pruneProjectedLiveActivities,
  reduceLiveActivityEvent,
} from "../src/live-activity.js";
import { describe, expect, it } from "vitest";

const runId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();
const invocationId = createToolInvocationId();

function transient(
  type: string,
  payload: Record<string, unknown>,
  streamKey: string,
  streamSequence: number,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: type.includes("output") ? 2 : 1,
    runId,
    sessionId,
    stepId,
    timestamp: 1_700_000_000_000 + streamSequence,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey,
      streamSequence,
    },
    type,
    payload,
  });
}

describe("LiveActivity projection", () => {
  it("tracks Provider wait status and activity time without inferring connection health", () => {
    const stepStarted = durableEvent(
      "llm.started",
      { model: { provider: "fixture", model: "fixture-model" } },
      1,
      1_700_000_000_000,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), stepStarted);
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(state.modelWait).toMatchObject({
      stepId,
      phase: "NO_RECENT_ACTIVITY",
      lastActivityAt: 1_699_999_900_000,
      providerEventReceived: false,
    });
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "RECEIVING_PROVIDER_DATA", 0, 300_000),
    );

    const delta = transient("model.text.delta", { text: "thinking" }, "model:text", 1);
    state = reduceLiveActivityEvent(state, delta);

    expect(state.modelWait).toMatchObject({
      runId,
      stepId,
      phase: "RECEIVING_PROVIDER_DATA",
      lastActivityAt: delta.timestamp,
      idleForMs: 0,
      idleTimeoutMs: 300_000,
      providerEventReceived: true,
    });
    expect(state.modelWait).not.toHaveProperty("connectionHealth");

    const otherStep = createStepId();
    const afterWrongStep = reduceLiveActivityEvent(
      state,
      modelStatus(otherStep, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(afterWrongStep.modelWait).toEqual(state.modelWait);
  });

  it("projects bounded retry, fallback and exhaustion progress using retry ordinals", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent(
        "retry.scheduled",
        {
          attempt: 2,
          maxAttempts: 6,
          delayMs: 2_000,
          nextAttemptAt: 1_700_000_002_000,
          errorCode: "LLM_NETWORK",
        },
        1,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "RETRY_SCHEDULED",
      retryOrdinal: 1,
      maxRetries: 5,
      attempt: 2,
      maxAttempts: 6,
      delayMs: 2_000,
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent("retry.started", { attempt: 2, maxAttempts: 6 }, 2),
    );
    state = reduceLiveActivityEvent(
      state,
      durableEvent("llm.started", { model: { provider: "fixture", model: "fixture-model" } }, 3),
    );
    expect(state.modelWait).toMatchObject({ phase: "RETRYING", retryOrdinal: 1, maxRetries: 5 });
    state = reduceLiveActivityEvent(state, modelStatus(stepId, "NO_RECENT_ACTIVITY", 1_000, 5_000));
    expect(state.modelWait).toMatchObject({
      phase: "NO_RECENT_ACTIVITY",
      retryOrdinal: 1,
      maxRetries: 5,
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "transport.fallback.selected",
        {
          attempt: 2,
          maxAttempts: 6,
          fromTransportId: "default",
          toTransportId: "secondary",
        },
        4,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "FALLBACK_SELECTED",
      fromTransportId: "default",
      toTransportId: "secondary",
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "retry.exhausted",
        {
          attempt: 6,
          maxAttempts: 6,
          retriesUsed: 5,
          maxRetries: 5,
          errorCode: "LLM_TIMEOUT",
          reason: "ATTEMPTS_EXHAUSTED",
        },
        5,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "RETRY_EXHAUSTED",
      retryOrdinal: 5,
      maxRetries: 5,
      errorCode: "LLM_TIMEOUT",
    });
  });

  it("does not resurrect a settled model wait when late status arrives or the Run ends", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent("llm.started", { model: { provider: "fixture", model: "fixture-model" } }, 1),
    );
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(state.modelWait).toMatchObject({ phase: "NO_RECENT_ACTIVITY", stepId });
    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "llm.completed",
        {
          model: { provider: "fixture", model: "fixture-model" },
          usage: { steps: 1, toolCalls: 0, inputTokens: 10, outputTokens: 2 },
        },
        2,
      ),
    );
    expect(state.modelWait).toBeUndefined();
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 60_000, 300_000),
    );
    expect(state.modelWait).toBeUndefined();

    state = reduceLiveActivityEvent(
      state,
      durableEvent("run.completed", { result: { status: "COMPLETED" } }, 3),
    );
    expect(state.terminal).toBe(true);
    expect(state.modelWait).toBeUndefined();
  });

  it("accumulates ordered live deltas, ignores duplicates/late events, and settles durably", () => {
    const textA = transient("model.text.delta", { text: "Hel" }, "model:text", 1);
    const textB = transient("model.text.delta", { text: "lo" }, "model:text", 2);
    let state = createInitialLiveActivityState(runId);
    state = reduceLiveActivityEvent(state, textA);
    state = reduceLiveActivityEvent(state, textB);
    const beforeDuplicate = state;
    state = reduceLiveActivityEvent(state, textA);

    expect(state).toBe(beforeDuplicate);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      kind: "MODEL_TEXT",
      text: "Hello",
      status: "ACTIVE",
    });

    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stdout", chunk: "working" },
      `tool:${invocationId}`,
      1,
    );
    state = reduceLiveActivityEvent(state, toolOutput);
    expect(state.activities.some((item) => item.kind === "TOOL_OUTPUT")).toBe(true);

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "tool.completed",
        payload: { invocationId, observationId: "obs_0195f3a0-0000-7000-8000-000000000000" },
      }),
    );
    expect(state.activities.find((item) => item.kind === "TOOL_OUTPUT")?.status).toBe("COMPLETED");

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        timestamp: 1_700_000_000_011,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 2 },
        type: "run.completed",
        payload: { result: { status: "COMPLETED" } },
      }),
    );
    expect(state.terminal).toBe(true);
    expect(state.activities.every((item) => item.status === "COMPLETED")).toBe(true);
  });

  it("preserves failed and cancelled terminal outcomes for live rows", () => {
    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stderr", chunk: "failed safely" },
      `tool:${invocationId}`,
      1,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), toolOutput);

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "tool.failed",
        payload: {
          invocationId,
          error: {
            code: "TOOL_EXECUTION_ERROR",
            message: "Tool execution failed.",
            retryable: false,
          },
        },
      }),
    );
    expect(state.activities[0]?.status).toBe("FAILED");

    const reasoning = transient(
      "model.reasoning_summary.delta",
      { text: "still working" },
      "model:reasoning",
      1,
    );
    state = reduceLiveActivityEvent(state, reasoning);
    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        timestamp: 1_700_000_000_011,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 2 },
        type: "run.cancelled",
        payload: { reason: "USER_REQUEST" },
      }),
    );

    expect(state.terminal).toBe(true);
    expect(state.activities.find((item) => item.kind === "MODEL_REASONING")?.status).toBe(
      "CANCELLED",
    );
    expect(state.activities.find((item) => item.kind === "TOOL_OUTPUT")?.status).toBe("FAILED");
  });

  it("prunes only terminal live rows covered by the durable presentation watermark", () => {
    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stdout", chunk: "done" },
      `tool:${invocationId}`,
      1,
    );
    const reasoning = transient(
      "model.reasoning_summary.delta",
      { text: "still active" },
      "model:reasoning",
      1,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), toolOutput);
    state = reduceLiveActivityEvent(state, reasoning);
    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 4 },
        type: "tool.completed",
        payload: { invocationId, observationId: "obs_0195f3a0-0000-7000-8000-000000000000" },
      }),
    );

    expect(pruneProjectedLiveActivities(state, 3).activities).toHaveLength(2);
    expect(pruneProjectedLiveActivities(state, 4).activities).toEqual([
      expect.objectContaining({ kind: "MODEL_REASONING", status: "ACTIVE" }),
    ]);
  });
});

function durableEvent(
  type: string,
  payload: Record<string, unknown>,
  sequence: number,
  timestamp = 100,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    ...(type.startsWith("llm.") ||
    type.startsWith("model.") ||
    type.startsWith("retry.") ||
    type.startsWith("transport.")
      ? { stepId }
      : {}),
    timestamp,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    type,
    payload,
  });
}

function modelStatus(
  targetStepId: ReturnType<typeof createStepId>,
  phase:
    | "WAITING_PROVIDER"
    | "RECEIVING_PROVIDER_DATA"
    | "NO_RECENT_ACTIVITY"
    | "CANCELLING_IDLE_STREAM",
  idleForMs: number,
  idleTimeoutMs: number,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    stepId: targetStepId,
    timestamp: 1_699_999_900_000 + idleForMs,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "COALESCIBLE",
      streamKey: `model:status:${runId}:${targetStepId}`,
    },
    type: "model.status",
    payload: {
      phase,
      lastActivityAt: 1_699_999_900_000,
      idleForMs,
      idleTimeoutMs,
    },
  });
}
