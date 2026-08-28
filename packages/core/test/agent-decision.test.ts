import {
  AgentKernelStateError,
  AgentModelOutputError,
  AgentToolResultBatchError,
  classifyAgentDecision,
} from "../src/index.js";
import type { AgentDecision, AgentModelTurn, AgentLoopOutcome } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import type { LLMTurnResult } from "@caelush/llm/turn";

const model = { provider: "fixture", model: "fixture-model" };

function makeTurnResult(overrides: Partial<LLMTurnResult> = {}): LLMTurnResult {
  return {
    callId: createLLMCallId(),
    providerId: "fixture",
    model,
    text: "candidate",
    toolCalls: [],
    finishReason: "STOP",
    ...overrides,
  };
}

describe("Agent decision contracts", () => {
  it("exports the discriminated decision and sanitized error contracts", () => {
    const decision: AgentDecision = {
      type: "FINAL_CANDIDATE",
      modelTurn: {} as AgentModelTurn,
      candidateText: "candidate",
    };
    expect(decision.type).toBe("FINAL_CANDIDATE");
    const outcome: AgentLoopOutcome = { type: "MAX_STEPS_REACHED", stepsCompleted: 2, maxSteps: 2 };
    expect(outcome.type).toBe("MAX_STEPS_REACHED");
    expect(AgentModelOutputError).toBeDefined();
    expect(AgentToolResultBatchError).toBeDefined();
    expect(AgentKernelStateError).toBeDefined();
  });

  it("classifies tool presence before finish reason and preserves canonical message order", () => {
    const result = makeTurnResult({
      text: "I'll inspect this.",
      toolCalls: [
        { id: "call_a", name: "read_file", input: { path: "a.ts", nested: { ok: true } } },
        { id: "call_b", name: "read_file", input: { path: "b.ts" } },
      ],
      finishReason: "STOP",
    });
    const decision = classifyAgentDecision(result);
    expect(decision.type).toBe("TOOL_CALLS_REQUESTED");
    expect(decision.toolRequests.map((request) => request.externalCallId)).toEqual([
      "call_a",
      "call_b",
    ]);
    expect(decision.modelTurn.assistantMessage.content).toEqual([
      { type: "text", text: "I'll inspect this." },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "read_file",
        input: { path: "a.ts", nested: { ok: true } },
      },
      { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
    ]);
  });

  it.each([
    ["STOP", "FINAL_CANDIDATE"],
    ["OTHER", "FINAL_CANDIDATE"],
  ] as const)("classifies nonblank %s text as %s", (finishReason, expectedType) => {
    const decision = classifyAgentDecision(
      makeTurnResult({ finishReason, text: "  hello\nworld  " }),
    );
    expect(decision.type).toBe(expectedType);
    if (decision.type === "FINAL_CANDIDATE") {
      expect(decision.candidateText).toBe("  hello\nworld  ");
    }
  });

  it.each(["LENGTH", "CONTENT_FILTER"] as const)(
    "rejects %s even when JSON tool input is parseable",
    (finishReason) => {
      expect(() =>
        classifyAgentDecision(
          makeTurnResult({
            finishReason,
            toolCalls: [{ id: "call_a", name: "read_file", input: { path: "a.ts" } }],
          }),
        ),
      ).toThrow(AgentModelOutputError);
    },
  );

  it("rejects blank finals, empty turns, zero tool calls, duplicate IDs, and identity mismatch", () => {
    expect(() => classifyAgentDecision(makeTurnResult({ text: "   " }))).toThrow(
      AgentModelOutputError,
    );
    expect(() =>
      classifyAgentDecision(makeTurnResult({ text: "", finishReason: "TOOL_CALLS" })),
    ).toThrow(AgentModelOutputError);
    expect(() =>
      classifyAgentDecision(
        makeTurnResult({
          toolCalls: [
            { id: "call_a", name: "read_file", input: {} },
            { id: "call_a", name: "read_file", input: {} },
          ],
        }),
      ),
    ).toThrow(AgentModelOutputError);
    expect(() =>
      classifyAgentDecision(makeTurnResult({ providerId: "other" })),
    ).toThrow(AgentModelOutputError);
  });

  it("allows parallel same-name calls when external IDs differ and permits unknown names", () => {
    const decision = classifyAgentDecision(
      makeTurnResult({
        toolCalls: [
          { id: "call_a", name: "read_file", input: {} },
          { id: "call_b", name: "read_file", input: {} },
          { id: "call_c", name: "future_tool", input: {} },
        ],
      }),
    );
    expect(decision.type).toBe("TOOL_CALLS_REQUESTED");
    expect(decision.toolRequests.map((request) => request.toolName)).toEqual([
      "read_file",
      "read_file",
      "future_tool",
    ]);
  });
});
