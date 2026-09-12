import { describe, expect, it } from "vitest";
import {
  classifyAgentDecision,
  summarizeAgentDecision,
  summarizeAgentLoopOutcome,
} from "../src/index.js";
import { modelTurnResult } from "./support/fake-model-turn-executor.js";

describe("Agent public summaries", () => {
  it("summarizes tool names without model text or arguments", () => {
    const decision = classifyAgentDecision(
      modelTurnResult({
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        text: "CAELUSH_PRIVATE_MODEL_TEXT",
        toolCalls: [
          { id: "call_a", name: "read_file", input: { secret: "CAELUSH_SECRET_DO_NOT_LEAK" } },
          { id: "call_b", name: "search_text", input: {} },
        ],
        finishReason: "TOOL_CALLS",
      }),
    );
    const summary = summarizeAgentDecision(decision);
    expect(summary).toContain("read_file");
    expect(summary).toContain("search_text");
    expect(summary).not.toContain("CAELUSH_PRIVATE_MODEL_TEXT");
    expect(summary).not.toContain("CAELUSH_SECRET_DO_NOT_LEAK");
  });

  it("limits displayed tool names and summarizes max steps", () => {
    const decision = classifyAgentDecision(
      modelTurnResult({
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        text: "",
        toolCalls: ["a", "b", "c", "d", "e", "f"].map((id, index) => ({
          id,
          name: `tool_${index}`,
          input: {},
        })),
        finishReason: "TOOL_CALLS",
      }),
    );
    expect(summarizeAgentDecision(decision)).toContain("+ 1 more");
    expect(
      summarizeAgentLoopOutcome({ type: "MAX_STEPS_REACHED", stepsCompleted: 8, maxSteps: 8 }),
    ).toContain("8");
  });

  it("does not include a final candidate's text in its summary", () => {
    const decision = classifyAgentDecision(
      modelTurnResult({
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        text: "CAELUSH_PRIVATE_MODEL_TEXT",
        toolCalls: [],
        finishReason: "STOP",
      }),
    );
    expect(summarizeAgentDecision(decision)).not.toContain("CAELUSH_PRIVATE_MODEL_TEXT");
  });
});
