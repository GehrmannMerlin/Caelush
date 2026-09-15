import type { ModelDescriptor } from "@caelush/ai";
import { createRunId, createSessionId, createStepId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentExecutionIdentity, AgentTurnRef } from "../src/loop/types.js";
import { createRunExecutionDriver } from "../src/run/run-execution-driver.js";
import type { CompletionGate, CompletionGateInput } from "../src/run/ports/completion-gate.js";
import type { RunExecutionDirective } from "../src/run/directive.js";
import type { ToolTurnCoordinator, ToolTurnRequest } from "../src/run/ports/tool-turn.js";

/**
 * The frozen driver, asserted as a boundary rather than as a worker.
 *
 * The driver executes exactly one typed effect per call and reports a typed result. What matters
 * here is that it forwards the *whole* frozen input to each port — an effect context field that a
 * port never receives is a field the production adapter would have to invent for itself.
 */

const AT = createTimestampMs(1_000);
const RUN_ID = createRunId();
const SESSION_ID = createSessionId();
const STEP_ID = createStepId();

const IDENTITY: AgentExecutionIdentity = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  goal: "inspect the project",
};

const TURN: AgentTurnRef = { stepId: STEP_ID, sequence: 1 };

const MODEL: ModelDescriptor = {
  provider: "fixture",
  model: "fixture-model",
} as unknown as ModelDescriptor;

const CANDIDATE = {
  type: "FINAL_CANDIDATE" as const,
  modelTurn: {
    callId: "llm_0195f3a0-0000-7000-8000-000000000000",
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "STOP" as const,
    assistantMessage: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "done" }],
    },
  },
  candidateText: "done",
};

/** A gate that records the exact input it was handed. */
function recordingGate(): { gate: CompletionGate; calls: CompletionGateInput[] } {
  const calls: CompletionGateInput[] = [];
  return {
    calls,
    gate: {
      id: "fixture-gate",
      evaluate: (input) => {
        calls.push(input);
        return Promise.resolve({
          kind: "ACCEPT",
          finalResult: { type: "TEXT", text: "done" },
        });
      },
    },
  };
}

function recordingToolTurns(): { coordinator: ToolTurnCoordinator; calls: ToolTurnRequest[] } {
  const calls: ToolTurnRequest[] = [];
  return {
    calls,
    coordinator: {
      execute: (request) => {
        calls.push(request);
        return Promise.resolve({ kind: "COMPLETED", results: [] });
      },
    },
  };
}

function driver(gate: CompletionGate, toolTurns: ToolTurnCoordinator) {
  return createRunExecutionDriver({
    agentLoop: {
      advance: () =>
        Promise.resolve({
          kind: "CANCELLED",
          turn: TURN,
          messagesToAppend: [],
        }),
    },
    toolTurns,
    completionGate: gate,
  });
}

const SIGNAL = new AbortController().signal;

const CONTEXT = {
  identity: IDENTITY,
  turn: TURN,
  history: [],
  model: MODEL,
  tools: [],
  signal: SIGNAL,
};

describe("DefaultRunExecutionDriver", () => {
  it("hands the completion gate the complete frozen input, identity included", async () => {
    const { gate, calls } = recordingGate();
    const { coordinator } = recordingToolTurns();

    const result = await driver(gate, coordinator).execute(
      {
        kind: "EVALUATE_COMPLETION",
        mode: "RECOVER",
        sourceStepId: STEP_ID,
        candidate: CANDIDATE,
      },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "COMPLETION",
      result: { kind: "ACCEPT", finalResult: { type: "TEXT", text: "done" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      identity: IDENTITY,
      mode: "RECOVER",
      sourceStepId: STEP_ID,
      candidate: CANDIDATE,
      signal: SIGNAL,
    });
    // The identity is the Run's, not a value re-derived inside the driver.
    expect(calls[0]?.identity.runId).toBe(RUN_ID);
    expect(calls[0]?.identity.sessionId).toBe(SESSION_ID);
  });

  it("forwards the Tool batch request unchanged", async () => {
    const { gate } = recordingGate();
    const { coordinator, calls } = recordingToolTurns();

    const result = await driver(gate, coordinator).execute(
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: STEP_ID,
        pendingDecision: {
          type: "TOOL_CALLS_REQUESTED",
          modelTurn: CANDIDATE.modelTurn,
          toolRequests: [
            { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
          ],
        },
      },
      CONTEXT,
    );

    expect(result).toEqual({ kind: "TOOLS", result: { kind: "COMPLETED", results: [] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe("EXECUTE");
    expect(calls[0]?.sourceStepId).toBe(STEP_ID);
    expect(calls[0]?.signal).toBe(SIGNAL);
    // The coordinator decided the batch; the driver must not invent an observation policy.
    expect(calls[0]?.observationPolicy).toBeUndefined();
  });

  it("executes nothing for a boundary or terminal directive", async () => {
    const { gate, calls: gateCalls } = recordingGate();
    const { coordinator, calls: toolCalls } = recordingToolTurns();

    const directives: readonly RunExecutionDirective[] = [
      { kind: "SUSPEND", boundary: "APPROVAL" },
      { kind: "SUSPEND", boundary: "RETRY", resumeAt: AT },
      { kind: "FINALIZE", reason: "CANCELLED" },
      { kind: "FINALIZE", reason: "TIMEOUT" },
      { kind: "FINALIZE", reason: "MAX_STEPS_REACHED" },
      { kind: "RETURN_TERMINAL" },
    ];

    for (const directive of directives) {
      const result = await driver(gate, coordinator).execute(directive, CONTEXT);
      // `NONE` is the whole answer: a driver that produced a state change here would be a second
      // lifecycle authority.
      expect(result, directive.kind).toEqual({ kind: "NONE" });
    }
    expect(gateCalls).toEqual([]);
    expect(toolCalls).toEqual([]);
  });
});
