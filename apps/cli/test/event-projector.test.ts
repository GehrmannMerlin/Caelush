import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  type AgentEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialCliState } from "../src/application/cli-state.js";
import { projectAgentEvent } from "../src/application/event-projector.js";

const runId = createRunId();
const otherRunId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();

describe("CLI AgentEvent projection", () => {
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

    const result = projectAgentEvent(state, event);

    expect(result.state.activeRun).toEqual({ runId, status: "VERIFYING" });
    expect(result.state.activity).toBe("Verifying");
    expect(result.state.transcript).toEqual([]);
    expect(result.terminal).toBe(false);
  });

  it("marks matching terminal events without exposing event payloads", () => {
    const state = {
      ...createInitialCliState(),
      bootstrap: "READY" as const,
      activeRun: { runId, status: "RUNNING" as const },
    };
    const event = eventOf("run.completed", { result: { hidden: "provider output" } });

    const result = projectAgentEvent(state, event);

    expect(result.terminal).toBe(true);
    expect(result.terminalStatus).toBe("COMPLETED");
    expect(result.state.transcript).toEqual([]);
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

    expect(projectAgentEvent(state, event).state).toEqual(state);
    expect(projectAgentEvent(state, mismatched).state).toEqual(state);
  });
});

function eventOf(type: AgentEvent["type"], payload: unknown): AgentEvent {
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
  } as AgentEvent;
}
