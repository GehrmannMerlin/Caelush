import { describe, expect, it } from "vitest";
import {
  AgentModelOutputError,
  classifyAgentDecision,
  createAgentDecisionClassifier,
} from "../src/index.js";
import type { AgentModelOutputErrorReason } from "../src/index.js";
import type { AIModelTurnResult, ModelRef } from "@caelush/ai";

/**
 * Frozen `AgentDecisionClassifier` semantics.
 *
 * The classifier is the only place where "the model stopped" becomes "the agent acts", so
 * every rule it enforces is a fail-closed rule. The two regressions these tests exist to
 * make impossible are `OTHER → FINAL_CANDIDATE` and `LENGTH → Tool execution`.
 */

const MODEL: ModelRef = { provider: "test", model: "model-a" };

const RESOLUTION = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
} as const;

function turn(partial: Partial<AIModelTurnResult> = {}): AIModelTurnResult {
  return {
    callId: "llm_0195f3a0-0000-7000-8000-000000000000" as AIModelTurnResult["callId"],
    providerId: MODEL.provider,
    model: MODEL,
    text: "",
    toolCalls: [],
    finishReason: "STOP",
    resolution: RESOLUTION as never,
    ...partial,
  };
}

function rejected(result: AIModelTurnResult): AgentModelOutputErrorReason {
  try {
    classifyAgentDecision(result);
  } catch (error) {
    if (error instanceof AgentModelOutputError) return error.reason;
    throw error;
  }
  throw new Error("expected the turn to be rejected");
}

describe("AgentDecisionClassifier", () => {
  it("classifies a STOP text answer as FINAL_CANDIDATE", () => {
    const decision = classifyAgentDecision(turn({ text: "  hello\nworld  " }));

    expect(decision.type).toBe("FINAL_CANDIDATE");
    if (decision.type !== "FINAL_CANDIDATE") throw new Error("expected a candidate");
    // The candidate text is the settled turn text, never a re-rendered message.
    expect(decision.candidateText).toBe("  hello\nworld  ");
    expect(decision.modelTurn.assistantMessage).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "  hello\nworld  " }],
    });
    expect(decision.modelTurn.finishReason).toBe("STOP");
    expect(decision.modelTurn.model).toEqual(MODEL);
  });

  it("classifies completed tool calls as TOOL_CALLS_REQUESTED in announcement order", () => {
    const decision = classifyAgentDecision(
      turn({
        text: "let me look",
        finishReason: "TOOL_CALLS",
        toolCalls: [
          { id: "call_a", name: "read_file", input: { path: "a.ts" } },
          { id: "call_b", name: "search_text", input: { query: "x" } },
        ],
      }),
    );

    expect(decision.type).toBe("TOOL_CALLS_REQUESTED");
    if (decision.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool requests");
    expect(decision.toolRequests).toEqual([
      { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
      { externalCallId: "call_b", toolName: "search_text", args: { query: "x" } },
    ]);
    expect(decision.modelTurn.assistantMessage.content).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a.ts" } },
      { type: "tool-call", toolCallId: "call_b", toolName: "search_text", input: { query: "x" } },
    ]);
  });

  it("copies tool arguments instead of sharing the adapter's object", () => {
    const input = { path: "a.ts", nested: { limit: 5 } };
    const decision = classifyAgentDecision(
      turn({
        finishReason: "TOOL_CALLS",
        toolCalls: [{ id: "call_a", name: "read_file", input }],
      }),
    );

    if (decision.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool requests");
    expect(decision.toolRequests[0]?.args).toEqual(input);
    expect(decision.toolRequests[0]?.args).not.toBe(input);
  });

  it("rejects LENGTH, so a truncated turn can never reach a Tool", () => {
    expect(
      rejected(
        turn({
          finishReason: "LENGTH",
          toolCalls: [{ id: "call_a", name: "read_file", input: { path: "a.ts" } }],
        }),
      ),
    ).toBe("OUTPUT_TRUNCATED");
  });

  it("rejects CONTENT_FILTER", () => {
    expect(rejected(turn({ finishReason: "CONTENT_FILTER", text: "x" }))).toBe("CONTENT_FILTERED");
  });

  it("rejects OTHER and never turns it into a final candidate", () => {
    const reason = rejected(turn({ finishReason: "OTHER", text: "looks finished" }));

    expect(reason).toBe("UNKNOWN_FINISH_REASON");
    expect(() => classifyAgentDecision(turn({ finishReason: "OTHER", text: "x" }))).toThrow(
      AgentModelOutputError,
    );
  });

  it("rejects an unknown finish reason that is not in the frozen set", () => {
    expect(rejected(turn({ finishReason: "SOMETHING_NEW" as never, text: "x" }))).toBe(
      "INVALID_TURN_RESULT",
    );
  });

  it("rejects a provider that does not match the model's provider", () => {
    expect(rejected(turn({ providerId: "someone-else", text: "x" }))).toBe(
      "MODEL_IDENTITY_MISMATCH",
    );
  });

  it("rejects duplicate tool-call ids", () => {
    const reason = rejected(
      turn({
        finishReason: "TOOL_CALLS",
        toolCalls: [
          { id: "call_a", name: "read_file", input: {} },
          { id: "call_a", name: "read_file", input: {} },
        ],
      }),
    );

    expect(reason).toBe("DUPLICATE_TOOL_CALL_ID");
  });

  it("rejects a tool-call finish reason that carries no call", () => {
    // A TOOL_CALLS turn with neither text nor a completed call is an empty response first,
    // and the empty-response rule is the earlier one. Both reasons refuse the turn.
    expect(rejected(turn({ finishReason: "TOOL_CALLS" }))).toBe("EMPTY_RESPONSE");
    // With text present the turn is not empty, so the tool-call rule is what refuses it.
    expect(rejected(turn({ finishReason: "TOOL_CALLS", text: "calling" }))).toBe(
      "MISSING_TOOL_CALLS",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \n  "],
  ])("rejects an %s answer", (_label, text) => {
    expect(rejected(turn({ text }))).toBe("EMPTY_RESPONSE");
  });

  it("carries only safe structural metadata on a rejection", () => {
    try {
      classifyAgentDecision(turn({ finishReason: "OTHER", text: "CAELUSH_SECRET_TEXT" }));
      throw new Error("expected a rejection");
    } catch (error) {
      if (!(error instanceof AgentModelOutputError)) throw error;
      expect(error.metadata).toEqual({
        callId: "llm_0195f3a0-0000-7000-8000-000000000000",
        providerId: "test",
        model: MODEL,
        finishReason: "OTHER",
        toolCallCount: 0,
      });
      expect(JSON.stringify(error)).not.toContain("CAELUSH_SECRET_TEXT");
    }
  });

  it("classifies identically through the frozen interface", () => {
    const classifier = createAgentDecisionClassifier();
    const result = turn({ text: "answer" });

    expect(classifier.classify(result)).toEqual(classifyAgentDecision(result));
  });
});
