import type {
  LLMAssistantMessage,
  LLMMessage,
  LLMToolResultMessage,
  LLMUserMessage,
} from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { ContextConversationError } from "../src/errors.js";
import {
  estimateLLMMessage,
  selectRecentConversation,
  validateAndGroupConversation,
} from "../src/conversation-history.js";

const user = (content: string): LLMUserMessage => ({ role: "user", content });
const assistant = (content: string): LLMAssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
});
const toolCall = (toolCallId: string, toolName = "read_file"): LLMAssistantMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId, toolName, input: { path: "src/a.ts" } }],
});
const toolResult = (toolCallId: string, toolName = "read_file"): LLMToolResultMessage => ({
  role: "tool",
  toolCallId,
  toolName,
  content: "result",
  isError: false,
});

const estimator = { estimateText: (text: string) => text.length };

describe("conversation history", () => {
  it("groups leading assistant continuation and complete user turns", () => {
    const messages = [assistant("lead"), user("one"), assistant("two")] satisfies LLMMessage[];
    const result = validateAndGroupConversation(messages, estimator);
    expect(result.groups.map((group) => group.messages)).toEqual([
      [messages[0]],
      [messages[1], messages[2]],
    ]);
  });

  it("accepts parallel tool results in reverse order", () => {
    const messages = [
      user("read both"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "a", toolName: "read_file", input: { path: "a" } },
          { type: "tool-call", toolCallId: "b", toolName: "read_file", input: { path: "b" } },
        ],
      },
      toolResult("b"),
      toolResult("a"),
    ] satisfies LLMMessage[];
    expect(validateAndGroupConversation(messages, estimator).groups).toHaveLength(1);
  });

  it.each([
    ["system message", [{ role: "system", content: "old" }]],
    ["orphan tool result", [user("x"), toolResult("missing")]],
    ["wrong tool name", [user("x"), toolCall("call"), toolResult("call", "shell")]],
    [
      "duplicate tool result",
      [user("x"), toolCall("call"), toolResult("call"), toolResult("call")],
    ],
    ["missing tool result", [user("x"), toolCall("call")]],
  ] satisfies Array<[string, LLMMessage[]]>)("%s fails closed", (_name, messages) => {
    expect(() => validateAndGroupConversation(messages, estimator)).toThrow(
      ContextConversationError,
    );
  });

  it("rejects malformed runtime values without leaking schema details", () => {
    const malformed = [{ role: "assistant", content: "not an array" }] as unknown as LLMMessage[];
    expect(() => validateAndGroupConversation(malformed, estimator)).toThrow(
      "conversation history contains an invalid message",
    );
  });

  it("selects only the newest contiguous complete suffix", () => {
    const messages = [
      user("one"),
      assistant("a"),
      user("two"),
      assistant("b"),
      user("three"),
      assistant("c"),
    ];
    const validation = validateAndGroupConversation(messages, estimator);
    const selected = selectRecentConversation(validation.groups, 182);
    expect(selected.messages).toEqual(messages.slice(2));
    expect(selected.droppedTurns).toBe(1);
    expect(selected.requiresCompaction).toBe(true);
  });

  it("does not split an oversized newest turn and requests future compaction", () => {
    const messages = [user("a"), assistant("a long answer")];
    const validation = validateAndGroupConversation(messages, estimator);
    const selected = selectRecentConversation(validation.groups, 1);
    expect(selected.messages).toEqual([]);
    expect(selected.latestTurnTooLarge).toBe(true);
    expect(selected.requiresCompaction).toBe(true);
  });

  it("estimates structured tool-call and tool-result fields", () => {
    const message = toolCall("call");
    expect(estimateLLMMessage(message, estimator)).toBe(JSON.stringify(message).length);
    expect(estimateLLMMessage(toolResult("call"), estimator)).toBe(
      JSON.stringify(toolResult("call")).length,
    );
  });
});
