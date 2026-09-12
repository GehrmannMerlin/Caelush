import {
  AgentRunSchema,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { ContextBudgetExceededError, ContextError } from "@caelush/context";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput, AgentLoopResumeInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import type { ModelTurnScript, PartialTurnResult } from "./support/fake-model-turn-executor.js";
import {
  aiError,
  fakeModelTurnExecutor,
  testModelCatalog,
} from "./support/fake-model-turn-executor.js";

const SECRET = "CAELUSH_LOOP_SECRET_DO_NOT_LEAK_42";

function input(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "fix parser",
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

function dependencies(script: ModelTurnScript, calls: string[] = []): AgentLoopDependencies {
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
    models: testModelCatalog(),
    modelTurns: fakeModelTurnExecutor(async (request, signal, callIndex) => {
      calls.push(JSON.stringify(request));
      return script(request, signal, callIndex);
    }),
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  };
}

function output(): PartialTurnResult {
  return {
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text: "partial",
    toolCalls: [{ id: "call_a", name: "read_file", input: {} }],
    finishReason: "LENGTH",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("AgentLoop failures", () => {
  it.each([
    [aiError("AI_NETWORK", { message: SECRET }), "NETWORK_ERROR"],
    [aiError("AI_RATE_LIMIT", { message: SECRET }), "RATE_LIMIT"],
    [aiError("AI_TIMEOUT", { message: SECRET }), "MODEL_TIMEOUT"],
    [aiError("AI_AUTHENTICATION", { message: SECRET }), "MODEL_ERROR"],
    [aiError("AI_INVALID_RESPONSE", { message: SECRET }), "MODEL_ERROR"],
    [aiError("AI_PROVIDER_ERROR", { message: SECRET }), "MODEL_ERROR"],
  ])("maps %s without retrying or leaking details", async (error, code) => {
    let calls = 0;
    const result = await new AgentLoop(
      dependencies(async () => {
        calls += 1;
        throw error;
      }),
    ).run(input());
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe(code);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.step?.status).toBe("FAILED");
    expect(result.state.status).toBe("RUNNING");
    expect(result.state.currentStepId).toBeUndefined();
    expect(result.state.usage.steps).toBe(1);
  });

  it("exposes safe retry metadata for a transient provider failure", async () => {
    const result = await new AgentLoop(
      dependencies(async () => {
        throw aiError("AI_RATE_LIMIT", { message: SECRET, retryAfterMs: 2_500 });
      }),
    ).run(input());
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.retry).toEqual({
      code: "AI_RATE_LIMIT",
      retryable: true,
      retryAfterMs: 2_500,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("does not expose retry metadata for an authentication failure", async () => {
    const result = await new AgentLoop(
      dependencies(async () => {
        throw aiError("AI_AUTHENTICATION", { message: SECRET });
      }),
    ).run(input());
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.retry).toBeUndefined();
  });

  it("settles a schema-valid rejected model turn with known usage", async () => {
    const result = await new AgentLoop(dependencies(async () => output())).run(input());
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("MODEL_ERROR");
    expect(result.step?.status).toBe("FAILED");
    expect(result.state.usage).toMatchObject({ steps: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("fails before Step when context preparation fails", async () => {
    const calls: string[] = [];
    const result = await new AgentLoop({
      ...dependencies(async () => output(), calls),
      inspector: {
        inspect: async () => {
          calls.push(SECRET);
          throw new ContextError(SECRET, SECRET);
        },
      },
    }).run(input());
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.step).toBeUndefined();
    expect(result.state.usage.steps).toBe(0);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("maps context budget failure and invalid tool batches without port calls", async () => {
    const calls: string[] = [];
    const budgetResult = await new AgentLoop({
      ...dependencies(async () => output(), calls),
      contextBuilder: {
        build: () => {
          throw new ContextBudgetExceededError({
            maxInputTokens: 1,
            safetyMarginTokens: 0,
            systemTokens: 1,
            currentUserTokens: 1,
            currentTurnTokens: 1,
            mandatoryTokens: 2,
          });
        },
      },
    }).run(input());
    expect(budgetResult.status).toBe("FAILED");
    if (budgetResult.status !== "FAILED") throw new Error("expected budget failure");
    expect(budgetResult.error.code).toBe("BUDGET_EXCEEDED");
    expect(budgetResult.state.usage.steps).toBe(0);

    calls.length = 0;
    const start = input();
    const resume: AgentLoopResumeInput = {
      ...start,
      pendingDecision: {
        type: "TOOL_CALLS_REQUESTED",
        modelTurn: {
          callId: createLLMCallId(),
          model: { provider: "fixture", model: "fixture-model" },
          finishReason: "TOOL_CALLS",
          assistantMessage: {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: {} },
            ],
          },
        },
        toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: {} }],
      },
      toolResults: [],
    };
    const invalidBatch = await new AgentLoop(
      dependencies(async () => output(), calls),
    ).resumeWithToolResults(resume);
    expect(invalidBatch.status).toBe("FAILED");
    if (invalidBatch.status !== "FAILED") throw new Error("expected tool failure");
    expect(invalidBatch.error.code).toBe("TOOL_OUTPUT_ERROR");
    expect(invalidBatch.messagesToAppend).toEqual([]);
    expect(calls).toEqual([]);
  });
});
