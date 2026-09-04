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
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";

function input(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "use the context runtime",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 2, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(0),
  });
  return {
    run: { ...pendingRun, status: "RUNNING", startedAt: createTimestampMs(0) },
    state: startAgentState(
      createInitialAgentState(pendingRun, createTimestampMs(0)),
      createTimestampMs(0),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
  };
}

describe("AgentLoop production context runtime contract", () => {
  it("uses the injected Context Runtime before calling the provider", async () => {
    const calls: string[] = [];
    const dependencies: AgentLoopDependencies = {
      inspector: { inspect: async () => (calls.push("inspect"), {} as never) },
      planner: { plan: async () => (calls.push("plan"), {} as never) },
      contextBuilder: { build: () => ({ messages: [], report: {} as never }) },
      contextRuntime: {
        prepareModelContext: async () => {
          calls.push("context-runtime");
          return { messages: [{ role: "user", content: "projected" }], report: {} as never };
        },
      },
      llmClient: {
        complete: async () => {
          calls.push("llm");
          return {} as never;
        },
      },
      clock: { now: () => createTimestampMs(1) },
      stepIdFactory: { create: () => createStepId() },
    };

    await new AgentLoop(dependencies).run(input());

    expect(calls).toEqual(["inspect", "plan", "context-runtime", "llm"]);
  });
});
