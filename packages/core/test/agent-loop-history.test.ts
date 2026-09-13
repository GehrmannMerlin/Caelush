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
    state: startAgentState(
      createInitialAgentState({ ...run, status: "PENDING" }, createTimestampMs(100)),
      createTimestampMs(100),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
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

  /**
   * The general kernel owns these checks, and Core delegates to it. What matters here is that the
   * delegation is not decorative: a mismatch the kernel refuses must be refused through this
   * facade too, with the host's own error type so the Run Layer settles it as before.
   */
  it("delegates pending-assistant consistency to the general validator", () => {
    const differentCall = {
      ...assistant,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_z",
          toolName: "read_file" as const,
          input: { path: "src/parser.ts" },
        },
      ],
    };
    const differentName = {
      ...assistant,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_a",
          toolName: "search_text" as never,
          input: { path: "src/parser.ts" },
        },
      ],
    };
    const differentArgs = {
      ...assistant,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_a",
          toolName: "read_file" as const,
          input: { path: "other.ts" },
        },
      ],
    };
    const differentOrder = {
      ...assistant,
      content: [{ type: "text" as const, text: "no tools" }],
    };
    for (const tail of [differentCall, differentName, differentArgs, differentOrder]) {
      expect(() =>
        prepareResumeHistory([{ role: "user", content: "fix" }, tail as never], pendingDecision, [
          result,
        ]),
      ).toThrow(AgentLoopInputError);
    }
  });

  it("rejects a result the durable ledger already recorded", () => {
    expect(() =>
      prepareResumeHistory(
        [
          { role: "user", content: "fix" },
          assistant,
          result,
          { role: "user", content: "fix again" },
          assistant,
        ],
        pendingDecision,
        [{ ...result }],
      ),
    ).toThrow(AgentLoopInputError);
  });

  it("rejects a history that is not a sequence of complete turns", () => {
    // An assistant that announced a tool call the ledger never answered.
    expect(() =>
      prepareResumeHistory(
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_orphan",
                toolName: "read_file" as never,
                input: {},
              },
            ],
          },
          { role: "user", content: "fix" },
          assistant,
        ],
        pendingDecision,
        [result],
      ),
    ).toThrow(AgentLoopInputError);
  });
});
