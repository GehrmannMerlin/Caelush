import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  type PublicRunEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialCliState } from "../src/application/cli-state.js";
import { projectPublicRunEvent } from "../src/application/event-projector.js";

const runId = createRunId();
const otherRunId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();

describe("CLI PublicRunEvent projection", () => {
  it("projects matching lifecycle statuses to safe activity labels", () => {
    const state = {
      ...createInitialCliState(),
      bootstrap: "READY" as const,
      composerEnabled: false,
      activeRun: { runId, status: "RUNNING" as const },
    };
    const event = eventOf("status.changed", {
      from: "RUNNING",
      to: "VERIFYING",
    });

    const result = projectPublicRunEvent(state, event);

    expect(result.state.activeRun).toEqual({ runId, status: "VERIFYING" });
    expect(result.state.activity).toBe("Verifying");
    expect(result.state.displayHistory).toEqual([]);
    expect(result.terminal).toBe(false);
  });

  it("marks matching terminal events without exposing event payloads", () => {
    const state = {
      ...createInitialCliState(),
      bootstrap: "READY" as const,
      activeRun: { runId, status: "RUNNING" as const },
    };
    const event = eventOf("run.completed", { result: { hidden: "provider output" } });

    const result = projectPublicRunEvent(state, event);

    expect(result.terminal).toBe(true);
    expect(result.terminalStatus).toBe("COMPLETED");
    expect(result.state.displayHistory).toEqual([]);
    expect(JSON.stringify(result.state)).not.toContain("provider output");
  });

  it("ignores valid detailed or mismatched events", () => {
    const state = {
      ...createInitialCliState(),
      bootstrap: "READY" as const,
      activeRun: { runId, status: "RUNNING" as const },
    };
    const event = eventOf("tool.output", {
      invocationId: "tinv_00000000-0000-7000-8000-000000000000",
      stream: "stdout",
      chunk: "secret output",
    });
    const mismatched = { ...event, runId: otherRunId };

    expect(projectPublicRunEvent(state, event).state.timeline.settled[0]?.text).toBe(
      "secret output",
    );
    expect(projectPublicRunEvent(state, mismatched).state).toEqual(state);
  });

  it("routes canonical ordered transient output to Live Activity instead of Timeline", () => {
    const state = {
      ...createInitialCliState(),
      bootstrap: "READY" as const,
      activeRun: { runId, status: "RUNNING" as const },
    };
    const event = {
      ...eventOf("model.reasoning_summary.delta", { text: "Inspecting the workspace." }),
      durability: {
        kind: "EPHEMERAL" as const,
        version: 1 as const,
        deliveryClass: "ORDERED" as const,
        streamKey: `model:reasoning:${runId}`,
        streamSequence: 1,
      },
    } as PublicRunEvent;

    const result = projectPublicRunEvent(state, event);

    expect(result.state.timeline.settled).toEqual([]);
    expect(result.state.liveActivity.activities).toContainEqual(
      expect.objectContaining({ kind: "MODEL_REASONING", text: "Inspecting the workspace." }),
    );
  });
});

function eventOf(type: PublicRunEvent["type"], payload: unknown): PublicRunEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type,
    runId,
    sessionId,
    stepId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload,
  } as PublicRunEvent;
}
