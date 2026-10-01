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
