import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";

function input(maxSteps = 3, completedSteps = 0): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect parser",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(0),
  });
  const run = { ...pendingRun, status: "RUNNING" as const, startedAt: createTimestampMs(0) };
  const state = startAgentState(
    createInitialAgentState(pendingRun, createTimestampMs(0)),
    createTimestampMs(0),
  );
  return {
    run,
    state: { ...state, usage: { ...state.usage, steps: completedSteps } },
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
  };
}

function dependencies(calls: string[]): AgentLoopDependencies {
  return {
    inspector: {
      inspect: async () => {
        calls.push("inspect");
        return {} as never;
      },
    },
    planner: {
      plan: async () => {
        calls.push("plan");
        return {} as never;
      },
    },
    contextBuilder: {
      build: () => {
        calls.push("build");
        return { messages: [{ role: "user", content: "context" }], report: {} as never };
      },
    },
    llmClient: {
      complete: async () => {
        calls.push("llm");
        return {} as never;
      },
    },
    clock: { now: () => 1 as never },
    stepIdFactory: { create: () => createStepId() },
  };
}

describe("AgentLoop context preparation", () => {
  it("short-circuits maxSteps before every expensive port", async () => {
    const calls: string[] = [];
    const result = await new AgentLoop(dependencies(calls)).run(input(1, 1));
    expect(result.status).toBe("OUTCOME");
    expect(calls).toEqual([]);
  });

  it("runs inspect, plan, build, then provider in order", async () => {
    const calls: string[] = [];
    await new AgentLoop(dependencies(calls)).run(input());
    expect(calls).toEqual(["inspect", "plan", "build", "llm"]);
  });
});
