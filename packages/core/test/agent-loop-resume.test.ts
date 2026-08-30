import {
  AgentRunSchema,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { LLMTurnResultSchema, type LLMTurnResult } from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput, AgentLoopResumeInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";

function makeInput(): AgentLoopCommonInput {
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
    limits: { maxSteps: 4, maxToolCalls: 10, timeoutMs: 1000 },
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
    contextLimits: { maxInputTokens: 5000 },
    signal: new AbortController().signal,
  };
}

function turn(
  text: string,
  toolCalls: LLMTurnResult["toolCalls"],
  finishReason: LLMTurnResult["finishReason"],
): LLMTurnResult {
  return LLMTurnResultSchema.parse({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

function tool(id: string, name: string, content: string) {
  return {
    role: "tool" as const,
    toolCallId: id,
    toolName: name as "read_file",
    content,
    isError: false,
  };
}

describe("AgentLoop.resumeWithToolResults", () => {
  it("carries the complete open user turn across two tool cycles", async () => {
    const initial = makeInput();
    const contexts: unknown[] = [];
    const turns = [
      turn(
        "inspect",
        [
          { id: "call_a", name: "read_file", input: { path: "a" } },
          { id: "call_b", name: "read_file", input: { path: "b" } },
        ],
        "TOOL_CALLS",
      ),
      turn("update", [{ id: "call_c", name: "read_file", input: { path: "c" } }], "TOOL_CALLS"),
      turn("final", [], "STOP"),
    ];
    const dependencies: AgentLoopDependencies = {
      inspector: { inspect: async () => ({}) as never },
      planner: { plan: async () => ({}) as never },
      contextBuilder: {
        build: (input) => {
          contexts.push(input);
          return {
            messages:
              input.mode === "TOOL_CONTINUATION"
                ? input.currentTurnMessages
                : [input.currentUserMessage],
            report: {} as never,
          };
        },
      },
      llmClient: { complete: async () => turns.shift()! },
      clock: { now: () => 10 as never },
      stepIdFactory: { create: () => createStepId() },
    };
    const loop = new AgentLoop(dependencies);
    const first = await loop.run(initial);
    expect(first.status).toBe("OUTCOME");
    if (first.status !== "OUTCOME" || first.outcome.type !== "TOOL_CALLS_REQUESTED") {
      throw new Error("expected first tool decision");
    }

    const firstResume: AgentLoopResumeInput = {
      ...initial,
      state: first.state,
      history: first.messagesToAppend,
      pendingDecision: first.outcome,
      toolResults: [tool("call_b", "read_file", "B"), tool("call_a", "read_file", "A")],
    };
    const second = await loop.resumeWithToolResults(firstResume);
    expect(second.status).toBe("OUTCOME");
    if (second.status !== "OUTCOME" || second.outcome.type !== "TOOL_CALLS_REQUESTED") {
      throw new Error("expected second tool decision");
    }
    const secondContext = contexts[1] as Extract<
      Parameters<AgentLoopDependencies["contextBuilder"]["build"]>[0],
      { mode: "TOOL_CONTINUATION" }
    >;
    expect(
      secondContext.currentTurnMessages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call_a", "call_b"]);

    const secondResume: AgentLoopResumeInput = {
      ...initial,
      state: second.state,
      history: [...first.messagesToAppend, ...second.messagesToAppend],
      pendingDecision: second.outcome,
      toolResults: [tool("call_c", "read_file", "C")],
    };
    const final = await loop.resumeWithToolResults(secondResume);
    expect(final.status).toBe("OUTCOME");
    if (final.status !== "OUTCOME") throw new Error("expected final outcome");
    expect(final.outcome.type).toBe("FINAL_CANDIDATE");
    expect(final.state.status).toBe("VERIFYING");
    expect(final.messagesToAppend.map((message) => message.role)).toEqual(["tool", "assistant"]);
    expect(contexts).toHaveLength(3);
    const lastContext = contexts[2] as Extract<
      Parameters<AgentLoopDependencies["contextBuilder"]["build"]>[0],
      { mode: "TOOL_CONTINUATION" }
    >;
    expect(lastContext.currentTurnMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(lastContext.currentTurnMessages.at(-1)?.role).toBe("tool");
  });
});
