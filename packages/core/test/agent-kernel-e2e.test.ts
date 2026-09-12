import {
  AgentRunSchema,
  createRunId,
  createLLMCallId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import type { JsonObject } from "@caelush/protocol";
import type { AIModelTurnResult } from "@caelush/ai";
import { describe, expect, it } from "vitest";
import {
  beginAgentStepState,
  classifyAgentDecision,
  completeAgentStep,
  createInitialAgentState,
  createRunningAgentStep,
  evaluateAgentStepGate,
  markAgentStateMaxStepsReached,
  markAgentStateVerifying,
  normalizeToolResultBatch,
  settleAgentStepState,
  startAgentState,
  summarizeAgentDecision,
} from "../src/index.js";
import { modelTurnResult } from "./support/fake-model-turn-executor.js";

function makeRun(maxSteps = 3) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect and fix",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 99, timeoutMs: 9999 },
    createdAt: createTimestampMs(100),
  });
}

function turn(
  text: string,
  toolCalls: Array<{ id: string; name: string; input: JsonObject }>,
  finishReason: "STOP" | "TOOL_CALLS" | "LENGTH",
): AIModelTurnResult {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

describe("Phase 6A pure Kernel E2E", () => {
  it("moves a run through tool boundary, manual resume results, and VERIFYING", () => {
    const run = makeRun(3);
    let state = startAgentState(
      createInitialAgentState(run, createTimestampMs(100)),
      createTimestampMs(110),
    );
    const gate1 = evaluateAgentStepGate(state, run.limits);
    expect(gate1).toEqual({ allowed: true, nextSequence: 1 });
    const step1Id = createStepId();
    state = beginAgentStepState(state, step1Id, createTimestampMs(120));
    const decision1 = classifyAgentDecision(
      turn(
        "I need to inspect the source.",
        [
          { id: "call_A", name: "read_file", input: { path: "a.ts" } },
          { id: "call_B", name: "read_file", input: { path: "b.ts" } },
        ],
        "TOOL_CALLS",
      ),
    );
    expect(decision1.type).toBe("TOOL_CALLS_REQUESTED");
    if (decision1.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool decision");
    expect(decision1.toolRequests).toHaveLength(2);
    const summary1 = summarizeAgentDecision(decision1);
    state = settleAgentStepState(state, { stepId: step1Id, now: createTimestampMs(130) });
    const step1 = completeAgentStep(
      createRunningAgentStep({
        id: step1Id,
        runId: run.id,
        sequence: 1,
        startedAt: createTimestampMs(120),
      }),
      { finishedAt: createTimestampMs(130), reasoningSummary: summary1 },
    );
    expect(step1.status).toBe("COMPLETED");
    const normalized = normalizeToolResultBatch(decision1.toolRequests, [
      { role: "tool", toolCallId: "call_B", toolName: "read_file", content: "B", isError: false },
      { role: "tool", toolCallId: "call_A", toolName: "read_file", content: "A", isError: false },
    ]);
    expect(normalized.map((result) => result.toolCallId)).toEqual(["call_A", "call_B"]);
    const gate2 = evaluateAgentStepGate(state, run.limits);
    expect(gate2).toEqual({ allowed: true, nextSequence: 2 });
    const step2Id = createStepId();
    state = beginAgentStepState(state, step2Id, createTimestampMs(140));
    const decision2 = classifyAgentDecision(turn("Fix completed.", [], "STOP"));
    expect(decision2.type).toBe("FINAL_CANDIDATE");
    state = settleAgentStepState(state, { stepId: step2Id, now: createTimestampMs(150) });
    expect(state.usage.steps).toBe(2);
    state = markAgentStateVerifying(state, createTimestampMs(160));
    expect(state.status).toBe("VERIFYING");
    expect(state.verification).toBe("NOT_RUN");
    expect(state.status).not.toBe("COMPLETED");
  });

  it("returns a max-step outcome after the configured single step", () => {
    const run = makeRun(1);
    let state = startAgentState(
      createInitialAgentState(run, createTimestampMs(100)),
      createTimestampMs(110),
    );
    const stepId = createStepId();
    state = beginAgentStepState(state, stepId, createTimestampMs(120));
    state = settleAgentStepState(state, { stepId, now: createTimestampMs(130) });
    expect(evaluateAgentStepGate(state, run.limits)).toEqual({
      allowed: false,
      outcome: { type: "MAX_STEPS_REACHED", stepsCompleted: 1, maxSteps: 1 },
    });
    expect(markAgentStateMaxStepsReached(state, createTimestampMs(140)).status).toBe(
      "MAX_STEPS_REACHED",
    );
  });

  it("rejects LENGTH with tool calls before any tool request is produced", () => {
    expect(() =>
      classifyAgentDecision(
        turn("partial", [{ id: "call_A", name: "read_file", input: { path: "a.ts" } }], "LENGTH"),
      ),
    ).toThrow();
  });
});
