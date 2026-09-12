import {
  AgentKernelStateError,
  AgentModelOutputError,
  AgentToolResultBatchError,
  classifyAgentDecision,
} from "../src/index.js";
import type { AgentDecision, AgentModelTurn, AgentLoopOutcome } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import type { AIModelTurnResult } from "@caelush/ai";

const model = { provider: "fixture", model: "fixture-model" };

function makeTurnResult(overrides: Partial<AIModelTurnResult> = {}): AIModelTurnResult {
  return {
    // The AI call id and the Protocol call id are two brands of the same string.
    callId: createLLMCallId() as unknown as AIModelTurnResult["callId"],
    providerId: "fixture",
    model,
    text: "candidate",
    toolCalls: [],
    finishReason: "STOP",
    resolution: {
      api: "test-api",
      reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
      cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
    },
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
    if (decision.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool decision");
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

  it("classifies nonblank STOP text as FINAL_CANDIDATE", () => {
    const decision = classifyAgentDecision(
      makeTurnResult({ finishReason: "STOP", text: "  hello\nworld  " }),
    );
    expect(decision.type).toBe("FINAL_CANDIDATE");
    if (decision.type === "FINAL_CANDIDATE") {
      expect(decision.candidateText).toBe("  hello\nworld  ");
    }
  });

  it("rejects an unrecognised provider finish reason instead of treating it as a stop", () => {
    // `OTHER` means the AI core could not interpret the provider reason. It is never
    // evidence that the model finished, so it fails closed rather than becoming a
    // final candidate.
    let captured: unknown;
    try {
      classifyAgentDecision(makeTurnResult({ finishReason: "OTHER", text: "  hello\nworld  " }));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(AgentModelOutputError);
    expect((captured as AgentModelOutputError).reason).toBe("UNKNOWN_FINISH_REASON");
    expect((captured as AgentModelOutputError).metadata.finishReason).toBe("OTHER");
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
    expect(() => classifyAgentDecision(makeTurnResult({ providerId: "other" }))).toThrow(
      AgentModelOutputError,
    );
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
    if (decision.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool decision");
    expect(decision.toolRequests.map((request) => request.toolName)).toEqual([
      "read_file",
      "read_file",
      "future_tool",
    ]);
  });
});
