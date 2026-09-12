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
import { AgentLoop } from "../src/agent-loop.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies, AgentLoopLifecycleHooks } from "../src/agent-loop-ports.js";
import {
  fakeModelTurnExecutor,
  testModelCatalog,
  modelTurnResult,
} from "./support/fake-model-turn-executor.js";

function makeInput(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
  return {
    run: { ...pendingRun, status: "RUNNING", startedAt: createTimestampMs(2) },
    state: startAgentState(
      createInitialAgentState(pendingRun, createTimestampMs(1)),
      createTimestampMs(2),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
  };
}

function dependencies(
  calls: string[],
  beforeProviderTurn?: AgentLoopLifecycleHooks["beforeProviderTurn"],
): AgentLoopDependencies {
  const baseDependencies: AgentLoopDependencies = {
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
        calls.push("context");
        return { messages: [{ role: "user", content: "context" }], report: {} as never };
      },
    },
    models: testModelCatalog(),
    modelTurns: fakeModelTurnExecutor(async () => {
      calls.push("provider");
      return modelTurnResult({
        callId: createLLMCallId(),
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        text: "answer",
        toolCalls: [],
        finishReason: "STOP",
      });
    }),
    clock: { now: () => createTimestampMs(3) },
    stepIdFactory: { create: () => createStepId() },
  };
  return beforeProviderTurn === undefined
    ? baseDependencies
    : { ...baseDependencies, lifecycle: { beforeProviderTurn } };
}

describe("AgentLoop provider lifecycle", () => {
  it("runs the pre-provider hook after the step is prepared and before the provider", async () => {
    const calls: string[] = [];
    let hookInput: unknown;
    const input = makeInput();
    const result = await new AgentLoop(
      dependencies(calls, async (value) => {
        calls.push("hook");
        hookInput = value;
      }),
    ).run(input);

    expect(calls).toEqual(["inspect", "plan", "context", "hook", "provider"]);
    expect(result).toMatchObject({ status: "OUTCOME", providerTurnState: "COMPLETED" });
    expect(hookInput).toMatchObject({
      run: input.run,
      state: { runId: input.run.id, status: "RUNNING" },
      step: { runId: input.run.id, status: "RUNNING" },
      model: input.run.model,
    });
    expect(hookInput).not.toHaveProperty("request");
    expect(hookInput).not.toHaveProperty("messages");
  });

  it("does not call the provider when the pre-provider hook fails", async () => {
    const calls: string[] = [];
    const result = await new AgentLoop(
      dependencies(calls, async () => {
        calls.push("hook");
        throw new Error("checkpoint failed");
      }),
    ).run(makeInput());

    expect(calls).toEqual(["inspect", "plan", "context", "hook"]);
    expect(result.status).toBe("FAILED");
    expect(result.providerTurnState).toBe("NOT_STARTED");
  });
});
