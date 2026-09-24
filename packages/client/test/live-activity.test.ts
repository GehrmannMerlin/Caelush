import {
  PublicRunEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import { createInitialLiveActivityState, reduceLiveActivityEvent } from "../src/live-activity.js";
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
    expect(state.activities.find((item) => item.kind === "TOOL_OUTPUT")?.status).toBe("SETTLED");

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
    expect(state.activities.every((item) => item.status === "SETTLED")).toBe(true);
  });
});
