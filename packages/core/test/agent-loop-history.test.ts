import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoopInputError } from "../src/agent-errors.js";
import { prepareResumeHistory, validateAgentLoopInput } from "../src/agent-loop-history.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";

function makeInput(): AgentLoopCommonInput {
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "fix parser",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    startedAt: createTimestampMs(100),
  });
  return {
    run,
    state: startAgentState(createInitialAgentState({ ...run, status: "PENDING" }, 100), 100),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
  };
}

const pendingDecision = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: {
    callId: "call-id" as never,
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS" as const,
    assistantMessage: {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_a",
          toolName: "read_file" as const,
          input: { path: "src/parser.ts" },
        },
      ],
    },
  },
  toolRequests: [
    { externalCallId: "call_a", toolName: "read_file" as const, args: { path: "src/parser.ts" } },
  ],
};

const assistant = pendingDecision.modelTurn.assistantMessage;
const result = {
  role: "tool" as const,
  toolCallId: "call_a",
  toolName: "read_file" as const,
  content: "source",
  isError: false,
};

describe("AgentLoop input and resume history", () => {
  it("rejects non-running or mismatched run/state projections", () => {
    const input = makeInput();
    expect(() =>
      validateAgentLoopInput({ ...input, run: { ...input.run, status: "PENDING" } }),
    ).toThrow(AgentLoopInputError);
    expect(() =>
      validateAgentLoopInput({ ...input, state: { ...input.state, goal: "different" } }),
    ).toThrow(AgentLoopInputError);
  });

  it("splits the previous history from a complete current open turn", () => {
    const input = makeInput();
    const split = prepareResumeHistory(
      [
        { role: "user", content: "old" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: "fix parser" },
        assistant,
      ],
      pendingDecision,
      [result],
    );
    expect(split.historyBeforeCurrentTurn).toEqual([
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ]);
    expect(split.currentTurnMessages).toEqual([
      { role: "user", content: "fix parser" },
      assistant,
      result,
    ]);
    expect(input.history).toEqual([]);
  });

  it("normalizes out-of-order results and compares tool args semantically", () => {
    const split = prepareResumeHistory(
      [{ role: "user", content: "fix" }, assistant],
      {
        ...pendingDecision,
        toolRequests: [{ ...pendingDecision.toolRequests[0]!, args: { path: "src/parser.ts" } }],
      },
      [{ ...result, content: "source" }],
    );
    expect(split.currentTurnMessages.at(-1)).toEqual(result);
  });

  it("rejects a pending assistant tail mismatch or an already-present result", () => {
    expect(() =>
      prepareResumeHistory(
        [{ role: "user", content: "fix" }, { ...assistant, content: [] } as never],
        pendingDecision,
        [result],
      ),
    ).toThrow(AgentLoopInputError);
    expect(() =>
      prepareResumeHistory([{ role: "user", content: "fix" }, assistant, result], pendingDecision, [
        result,
      ]),
    ).toThrow(AgentLoopInputError);
  });
});
