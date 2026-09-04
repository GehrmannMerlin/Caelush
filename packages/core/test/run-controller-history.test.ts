import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import {
  buildRunExecutionHistory,
  buildRunExecutionHistorySourceSequences,
} from "../src/run-controller-history.js";

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

  it("aligns durable message sequences with the history handed to the Context Runtime", () => {
    const durable = [
      { message: { role: "user" as const, content: "old goal" }, sequence: 10 },
      {
        message: { role: "assistant" as const, content: [{ type: "text" as const, text: "old" }] },
        sequence: 20,
      },
      {
        message: {
          role: "tool" as const,
          toolCallId: "old",
          toolName: "echo_value" as const,
          content: "old",
          isError: false,
        },
        sequence: 30,
      },
      ...durableConversation.map((message, index) => ({
        message,
        sequence: 40 + index * 10,
      })),
    ];

    expect(
      buildRunExecutionHistorySourceSequences({ durableConversation: durable, mode: "RUN" }),
    ).toEqual([10, 20, 30]);
    expect(
      buildRunExecutionHistorySourceSequences({
        durableConversation: durable,
        mode: "RESUME_WITH_TOOL_RESULTS",
      }),
    ).toEqual([10, 20, 30, 40, 50, 60]);
    expect(
      buildRunExecutionHistorySourceSequences({
        historyPrefix: prefix,
        durableConversation: durable,
        mode: "RUN",
      }),
    ).toBeUndefined();
  });
});
