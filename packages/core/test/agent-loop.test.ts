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
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import {
  fakeModelTurnExecutor,
  modelTurnResult,
  testModelCatalog,
} from "./support/fake-model-turn-executor.js";
import type { AIModelTurnResult } from "@caelush/ai";

function input(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "  fix parser\n",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1000 },
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

function turn(
  text: string,
  toolCalls: AIModelTurnResult["toolCalls"],
  finishReason: AIModelTurnResult["finishReason"],
): AIModelTurnResult {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

function dependencies(modelTurn: AIModelTurnResult): AgentLoopDependencies {
  return {
    inspector: { inspect: async () => ({}) as never },
    planner: { plan: async () => ({}) as never },
    contextBuilder: {
      build: () => ({ messages: [{ role: "user", content: "context" }], report: {} as never }),
    },
    models: testModelCatalog(),
    modelTurns: fakeModelTurnExecutor(async () => modelTurn),
    clock: { now: () => 10 as never },
    stepIdFactory: { create: () => createStepId() },
  };
}

describe("AgentLoop.run", () => {
  it("settles a final candidate and moves state to VERIFYING", async () => {
    const request = input();
    const result = await new AgentLoop(dependencies(turn("final answer", [], "STOP"))).run(request);

    expect(result.status).toBe("OUTCOME");
    if (result.status !== "OUTCOME") throw new Error("expected outcome");
    expect(result.outcome.type).toBe("FINAL_CANDIDATE");
    expect(result.state.status).toBe("VERIFYING");
    expect(result.state.usage).toMatchObject({ steps: 1, inputTokens: 10, outputTokens: 5 });
    expect(result.step?.status).toBe("COMPLETED");
    expect(result.messagesToAppend).toEqual([
      { role: "user", content: "  fix parser\n" },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ]);
  });

  it("yields tool calls without executing them and leaves state RUNNING", async () => {
    const result = await new AgentLoop(
      dependencies(
        turn(
          "inspect first",
          [{ id: "call_a", name: "read_file", input: { path: "src/parser.ts" } }],
          "TOOL_CALLS",
        ),
      ),
    ).run(input());

    expect(result.status).toBe("OUTCOME");
    if (result.status !== "OUTCOME") throw new Error("expected outcome");
    expect(result.outcome.type).toBe("TOOL_CALLS_REQUESTED");
    expect(result.state.status).toBe("RUNNING");
    expect(result.step?.status).toBe("COMPLETED");
    expect(result.messagesToAppend.at(0)?.role).toBe("user");
    expect(result.messagesToAppend.at(1)?.role).toBe("assistant");
  });

  it("does not mutate the caller-owned run, state, history, or tool definitions", async () => {
    const request = input();
    Object.freeze(request.run);
    Object.freeze(request.state);
    Object.freeze(request.history);
    Object.freeze(request.tools);
    const before = {
      run: request.run,
      state: request.state,
      history: request.history,
      tools: request.tools,
    };

    const result = await new AgentLoop(dependencies(turn("final answer", [], "STOP"))).run(request);

    expect(result.status).toBe("OUTCOME");
    expect(request.run).toBe(before.run);
    expect(request.state).toBe(before.state);
    expect(request.history).toBe(before.history);
    expect(request.tools).toBe(before.tools);
  });
});
