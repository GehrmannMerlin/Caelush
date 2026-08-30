import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { LLMTurnResultSchema } from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";

function input(signal: AbortSignal): AgentLoopCommonInput {
  const pending = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "cancel me",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 },
    createdAt: createTimestampMs(0),
  });
  return {
    run: { ...pending, status: "RUNNING", startedAt: createTimestampMs(0) },
    state: startAgentState(
      createInitialAgentState(pending, createTimestampMs(0)),
      createTimestampMs(0),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal,
  } as AgentLoopCommonInput;
}

describe("AgentLoop cancellation", () => {
  it("returns CANCELLED without calling the provider for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let providerCalls = 0;
    const dependencies = {
      inspector: { inspect: async () => ({}) as never },
      planner: { plan: async () => ({}) as never },
      contextBuilder: { build: () => ({ messages: [], report: {} as never }) },
      llmClient: {
        complete: async () => {
          providerCalls += 1;
          return LLMTurnResultSchema.parse({
            callId: "call_fixture",
            providerId: "fixture",
            model: { provider: "fixture", model: "fixture-model" },
            text: "late result",
            toolCalls: [],
            finishReason: "STOP",
          });
        },
      },
      clock: { now: () => createTimestampMs(10) },
      stepIdFactory: { create: () => createStepId() },
    } as unknown as AgentLoopDependencies;

    const result = await new AgentLoop(dependencies).run(input(controller.signal));

    expect(result.status).toBe("CANCELLED");
    expect(providerCalls).toBe(0);
    expect(result.messagesToAppend).toEqual([]);
  });
});
