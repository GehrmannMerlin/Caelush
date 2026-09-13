import { describe, expect, it } from "vitest";
import {
  AgentTurnInputError,
  assertAgentTurnInput,
  assertConversationProtocolIntegrity,
  assertPendingAssistantHistory,
} from "../src/index.js";
import type { AgentToolCallsDecision, AgentTurnInput } from "../src/index.js";
import type { AIAssistantMessage, AIMessage, AIToolResultMessage } from "@caelush/ai";
import { createStepId, type StepId } from "@caelush/protocol";

/**
 * General Agent turn-input and conversation integrity.
 *
 * These are the kernel's own protocol questions, asked without a Run, a workspace, a Tool or a
 * provider. Every rejection below is a fail-closed rule: the loop must refuse an inconsistent
 * turn rather than send the provider a request whose tool protocol does not hold.
 */

const SOURCE_STEP = createStepId();

const ASSISTANT: AIAssistantMessage = {
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a.ts" } },
    { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
  ],
};

const DECISION: AgentToolCallsDecision = {
  type: "TOOL_CALLS_REQUESTED",
  modelTurn: {
    callId: "llm_0195f3a0-0000-7000-8000-000000000000",
    model: { provider: "test", model: "model-a" },
    finishReason: "TOOL_CALLS",
    assistantMessage: ASSISTANT,
  },
  toolRequests: [
    { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
    { externalCallId: "call_b", toolName: "read_file", args: { path: "b.ts" } },
  ],
};

function toolResult(toolCallId: string, toolName = "read_file"): AIToolResultMessage {
  return { role: "tool", toolCallId, toolName, content: `data:${toolCallId}`, isError: false };
}

function toolResultsTurn(
  results: readonly AIToolResultMessage[],
  sourceStepId: StepId = SOURCE_STEP,
): AgentTurnInput {
  return { kind: "TOOL_RESULTS", sourceStepId, pendingDecision: DECISION, results };
}

function expectReason(run: () => void, reason: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentTurnInputError);
    expect((error as AgentTurnInputError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ${reason}`);
}

describe("assertAgentTurnInput", () => {
  it("accepts a complete, ordered tool result batch", () => {
    expect(() =>
      assertAgentTurnInput(toolResultsTurn([toolResult("call_a"), toolResult("call_b")])),
    ).not.toThrow();
  });

  it("accepts a user turn and both continuation reasons", () => {
    expect(() =>
      assertAgentTurnInput({ kind: "USER_INPUT", messages: [{ role: "user", content: "hi" }] }),
    ).not.toThrow();
    expect(() =>
      assertAgentTurnInput({ kind: "CONTINUATION", reason: "VERIFICATION_REPAIR" }),
    ).not.toThrow();
    expect(() => assertAgentTurnInput({ kind: "CONTINUATION", reason: "STEERING" })).not.toThrow();
  });

  it("rejects a wrong result count", () => {
    expectReason(
      () => assertAgentTurnInput(toolResultsTurn([toolResult("call_a")])),
      "TOOL_RESULT_COUNT_MISMATCH",
    );
    expectReason(
      () =>
        assertAgentTurnInput(
          toolResultsTurn([toolResult("call_a"), toolResult("call_b"), toolResult("extra")]),
        ),
      "TOOL_RESULT_COUNT_MISMATCH",
    );
  });

  it("rejects a wrong tool call id", () => {
    expectReason(
      () => assertAgentTurnInput(toolResultsTurn([toolResult("call_b"), toolResult("call_a")])),
      "TOOL_RESULT_ID_MISMATCH",
    );
  });

  it("rejects a wrong tool name", () => {
    expectReason(
      () =>
        assertAgentTurnInput(
          toolResultsTurn([toolResult("call_a", "search_text"), toolResult("call_b")]),
        ),
      "TOOL_RESULT_NAME_MISMATCH",
    );
  });

  it("rejects a reordered batch instead of normalizing it", () => {
    // The batch is positional by contract. Normalizing here would let the caller believe it had
    // answered calls it had not, and the model would see results attributed to the wrong call.
    expectReason(
      () => assertAgentTurnInput(toolResultsTurn([toolResult("call_b"), toolResult("call_a")])),
      "TOOL_RESULT_ID_MISMATCH",
    );
  });

  it("rejects a duplicate result id and a duplicate request id", () => {
    expectReason(
      () => assertAgentTurnInput(toolResultsTurn([toolResult("call_a"), toolResult("call_a")])),
      "DUPLICATE_TOOL_RESULT_ID",
    );
    expectReason(
      () =>
        assertAgentTurnInput({
          kind: "TOOL_RESULTS",
          sourceStepId: SOURCE_STEP,
          pendingDecision: {
            ...DECISION,
            toolRequests: [DECISION.toolRequests[0]!, DECISION.toolRequests[0]!],
          },
          results: [toolResult("call_a"), toolResult("call_b")],
        }),
      "DUPLICATE_TOOL_REQUEST_ID",
    );
  });

  it("rejects a batch without the Step that requested the tools", () => {
    expectReason(
      () =>
        assertAgentTurnInput({
          kind: "TOOL_RESULTS",
          sourceStepId: "" as StepId,
          pendingDecision: DECISION,
          results: [toolResult("call_a"), toolResult("call_b")],
        }),
      "MISSING_SOURCE_STEP_ID",
    );
  });

  it("rejects an empty batch, a malformed result and an empty user turn", () => {
    expectReason(() => assertAgentTurnInput(toolResultsTurn([])), "EMPTY_TOOL_RESULTS");
    expectReason(
      () =>
        assertAgentTurnInput(
          toolResultsTurn([
            { role: "tool", toolCallId: "", toolName: "read_file", content: "", isError: false },
            toolResult("call_b"),
          ]),
        ),
      "INVALID_TOOL_RESULT",
    );
    expectReason(
      () => assertAgentTurnInput({ kind: "USER_INPUT", messages: [] }),
      "EMPTY_USER_INPUT",
    );
  });

  it("rejects an unknown continuation reason and an unknown turn kind", () => {
    expectReason(
      () => assertAgentTurnInput({ kind: "CONTINUATION", reason: "SOMETHING_ELSE" }),
      "INVALID_CONTINUATION_REASON",
    );
    expectReason(() => assertAgentTurnInput({ kind: "NOT_A_TURN" }), "INVALID_TURN_INPUT_KIND");
    expectReason(() => assertAgentTurnInput(null), "INVALID_TURN_INPUT_KIND");
  });
});

describe("assertPendingAssistantHistory", () => {
  const history: readonly AIMessage[] = [{ role: "user", content: "fix the parser" }, ASSISTANT];

  it("accepts a history whose tail is exactly the pending assistant", () => {
    expect(() =>
      assertPendingAssistantHistory(history, DECISION, [
        toolResult("call_a"),
        toolResult("call_b"),
      ]),
    ).not.toThrow();
  });

  it("accepts tool args that differ only in key order", () => {
    const reordered: AgentToolCallsDecision = {
      ...DECISION,
      toolRequests: [
        { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
        { externalCallId: "call_b", toolName: "read_file", args: { path: "b.ts" } },
      ],
    };
    expect(() =>
      assertPendingAssistantHistory(history, reordered, [
        toolResult("call_a"),
        toolResult("call_b"),
      ]),
    ).not.toThrow();
  });

  it("rejects a missing pending assistant", () => {
    expectReason(
      () => assertPendingAssistantHistory([{ role: "user", content: "fix" }], DECISION, []),
      "PENDING_ASSISTANT_MISSING",
    );
  });

  it("rejects a different tool call, name, args or order", () => {
    const differentId: AIAssistantMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_z", toolName: "read_file", input: { path: "a.ts" } },
        { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
      ],
    };
    const differentName: AIAssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_a",
          toolName: "search_text",
          input: { path: "a.ts" },
        },
        { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
      ],
    };
    const differentArgs: AIAssistantMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "z.ts" } },
        { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
      ],
    };
    const differentOrder: AIAssistantMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
        { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a.ts" } },
      ],
    };
    for (const tail of [differentId, differentName, differentArgs, differentOrder]) {
      expectReason(
        () =>
          assertPendingAssistantHistory([{ role: "user", content: "fix" }, tail], DECISION, [
            toolResult("call_a"),
            toolResult("call_b"),
          ]),
        "PENDING_ASSISTANT_MISMATCH",
      );
    }
  });

  it("rejects a batch whose results the history already recorded", () => {
    // An earlier turn in the same ledger already consumed `call_a`. Re-supplying it would show
    // the model the same observation twice, so the resume is refused rather than replayed.
    const ledger: readonly AIMessage[] = [
      { role: "user", content: "fix" },
      ASSISTANT,
      toolResult("call_a"),
      toolResult("call_b"),
      { role: "user", content: "fix again" },
      ASSISTANT,
    ];
    expectReason(
      () => assertPendingAssistantHistory(ledger, DECISION, [toolResult("call_a")]),
      "TOOL_RESULT_ALREADY_PRESENT",
    );
  });
});

describe("assertConversationProtocolIntegrity", () => {
  it("accepts a history of complete turns", () => {
    expect(() =>
      assertConversationProtocolIntegrity([
        { role: "user", content: "fix" },
        ASSISTANT,
        toolResult("call_a"),
        toolResult("call_b"),
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]),
    ).not.toThrow();
  });

  it("accepts an empty history", () => {
    expect(() => assertConversationProtocolIntegrity([])).not.toThrow();
  });

  it("rejects an orphaned tool call and an unattributed result", () => {
    expectReason(
      () => assertConversationProtocolIntegrity([{ role: "user", content: "fix" }, ASSISTANT]),
      "INCOMPLETE_CONVERSATION",
    );
    expectReason(
      () => assertConversationProtocolIntegrity([toolResult("call_a")]),
      "INCOMPLETE_CONVERSATION",
    );
  });

  it("rejects a result that answers the wrong call and a duplicate announcement", () => {
    expectReason(
      () =>
        assertConversationProtocolIntegrity([
          { role: "user", content: "fix" },
          ASSISTANT,
          toolResult("call_b"),
          toolResult("call_a"),
        ]),
      "INCOMPLETE_CONVERSATION",
    );
    expectReason(
      () =>
        assertConversationProtocolIntegrity([
          { role: "user", content: "fix" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_a",
                toolName: "read_file",
                input: { path: "a.ts" },
              },
              {
                type: "tool-call",
                toolCallId: "call_a",
                toolName: "read_file",
                input: { path: "b.ts" },
              },
            ],
          },
        ]),
      "DUPLICATE_TOOL_REQUEST_ID",
    );
  });

  it("rejects a malformed message", () => {
    expectReason(
      () => assertConversationProtocolIntegrity([{ role: "user", content: 7 } as never]),
      "INVALID_HISTORY",
    );
  });
});
