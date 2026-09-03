import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { buildModelContextProjection } from "../src/model-context-projection.js";

const closedHistory: LLMMessage[] = Array.from({ length: 50 }, (_, index) => [
  {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: `done-${index}` },
      {
        type: "tool-call" as const,
        toolCallId: `call-${index}`,
        toolName: "read_file" as const,
        input: { path: `src/file-${index}.ts` },
      },
    ],
  },
  {
    role: "tool" as const,
    toolCallId: `call-${index}`,
    toolName: "read_file" as const,
    content: `observation-${index}`,
    isError: false,
  },
]).flat();

describe("ModelContextProjection", () => {
  it("keeps durable history separate and bounds a long run to goal plus recent tail", () => {
    const original = structuredClone(closedHistory);
    const projection = buildModelContextProjection({
      goal: "do not modify database/",
      durableHistory: closedHistory,
      recentTail: closedHistory.slice(-4),
      maxRecentTailTokens: 100_000,
      estimator: { estimateText: (text) => text.length },
    });

    expect(closedHistory).toEqual(original);
    expect(projection.messages[0]).toEqual({
      role: "user",
      content: "do not modify database/",
    });
    expect(projection.messages.length).toBeLessThan(10);
    expect(projection.messages).toEqual(expect.arrayContaining(closedHistory.slice(-2)));
    expect(projection.durableHistoryMessageCount).toBe(100);
  });
});
