import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { buildRunExecutionHistory } from "../src/run-controller-history.js";

const prefix: readonly LLMMessage[] = [
  { role: "user", content: "first goal" },
  { role: "assistant", content: [{ type: "text", text: "first verified result" }] },
];

const durableConversation: readonly LLMMessage[] = [
  { role: "user", content: "current goal" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "a.txt" },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-1",
    toolName: "read_file",
    content: "ok",
    isError: false,
  },
];

describe("RunController history preparation", () => {
  it("keeps the current open turn out of fresh AgentLoop history", () => {
    const result = buildRunExecutionHistory({
      historyPrefix: prefix,
      durableConversation,
      mode: "RUN",
    });

    expect(result).toEqual(prefix);
    expect(result).not.toContainEqual({ role: "user", content: "current goal" });
    expect(durableConversation).toHaveLength(3);
  });

  it("keeps the complete current open turn for Tool-result continuation", () => {
    const result = buildRunExecutionHistory({
      historyPrefix: prefix,
      durableConversation,
      mode: "RESUME_WITH_TOOL_RESULTS",
    });

    expect(result).toEqual([...prefix, ...durableConversation]);
  });
});
