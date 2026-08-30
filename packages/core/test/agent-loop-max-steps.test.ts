import {
  AgentRunSchema,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput, AgentLoopResumeInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";

function input(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "goal",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 1, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(0),
  });
  const state = startAgentState(
    createInitialAgentState(pendingRun, createTimestampMs(0)),
    createTimestampMs(0),
  );
  return {
    run: { ...pendingRun, status: "RUNNING", startedAt: createTimestampMs(0) },
    state: { ...state, usage: { ...state.usage, steps: 1 } },
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
  };
}

function noCalls(): AgentLoopDependencies {
  const fail = async (): Promise<never> => {
    throw new Error("expensive port should not run");
  };
  return {
    inspector: { inspect: fail },
    planner: { plan: fail },
    contextBuilder: { build: fail as never },
    llmClient: { complete: fail },
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  };
}

const assistant = {
  role: "assistant" as const,
  content: [
    {
      type: "tool-call" as const,
      toolCallId: "call_a",
      toolName: "read_file" as const,
      input: { path: "src/parser.ts" },
    },
  ],
};
const pendingDecision = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: {
    callId: createLLMCallId(),
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS" as const,
    assistantMessage: assistant,
  },
  toolRequests: [
    { externalCallId: "call_a", toolName: "read_file" as const, args: { path: "src/parser.ts" } },
  ],
};
const result = {
  role: "tool" as const,
  toolCallId: "call_a",
  toolName: "read_file" as const,
  content: "source",
  isError: false,
};

describe("AgentLoop maxSteps and append semantics", () => {
  it("does not prepare or call the provider at the start boundary", async () => {
    const result = await new AgentLoop(noCalls()).run(input());
    expect(result).toMatchObject({
      status: "OUTCOME",
      outcome: { type: "MAX_STEPS_REACHED" },
      state: { status: "MAX_STEPS_REACHED" },
    });
    expect(result.step).toBeUndefined();
    expect(result.contextReport).toBeUndefined();
    expect(result.messagesToAppend).toEqual([{ role: "user", content: "goal" }]);
  });

  it("normalizes and returns external tool results even when resume is maxed out", async () => {
    const start = input();
    const resume: AgentLoopResumeInput = {
      ...start,
      history: [{ role: "user", content: "goal" }, assistant],
      pendingDecision,
      toolResults: [{ ...result }],
    };
    const loop = new AgentLoop(noCalls());
    const execution = await loop.resumeWithToolResults(resume);
    expect(execution).toMatchObject({
      status: "OUTCOME",
      outcome: { type: "MAX_STEPS_REACHED" },
      state: { status: "MAX_STEPS_REACHED" },
    });
    expect(execution.step).toBeUndefined();
    expect(execution.contextReport).toBeUndefined();
    expect(execution.messagesToAppend).toEqual([result]);
  });
});
