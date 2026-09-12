import { describe, expect, it } from "vitest";
import { translateOpenAICompatibleMessages } from "../../../src/adapters/openai-compatible/message-translator.js";
import type { AIMessage } from "../../../src/messages/index.js";

describe("OpenAI-compatible message translation", () => {
  it("sends a single user message unchanged", () => {
    const translated = translateOpenAICompatibleMessages([{ role: "user", content: "hello" }]);

    expect(translated).toEqual({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(translated).not.toHaveProperty("instructions");
  });

  it("collects system messages into instructions and keeps them out of messages", () => {
    const translated = translateOpenAICompatibleMessages([
      { role: "system", content: "you are caelush" },
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ]);

    expect(translated.instructions).toBe("you are caelush\n\nbe concise");
    expect(translated.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("translates an assistant text message", () => {
    const translated = translateOpenAICompatibleMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);

    expect(translated.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("translates an assistant tool call without adding runtime metadata", () => {
    const translated = translateOpenAICompatibleMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
    ]);

    expect(translated.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
      ],
    });
    expect(Object.keys((translated.messages[0] as { content: object[] }).content[1]!)).toEqual([
      "type",
      "toolCallId",
      "toolName",
      "input",
    ]);
  });

  it("keeps a successful tool result as a text tool result", () => {
    const translated = translateOpenAICompatibleMessages([
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "read_file",
        content: "file body",
        isError: false,
      },
    ]);

    expect(translated.messages[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: { type: "text", value: "file body" },
        },
      ],
    });
  });

  it("keeps a failed tool result as an error tool result", () => {
    const translated = translateOpenAICompatibleMessages([
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "read_file",
        content: "not found",
        isError: true,
      },
    ]);

    expect(translated.messages[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: { type: "error-text", value: "not found" },
        },
      ],
    });
  });

  it("preserves multi-turn order", () => {
    const messages: AIMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "three" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} }],
      },
      { role: "tool", toolCallId: "c1", toolName: "t", content: "r", isError: false },
      { role: "assistant", content: [{ type: "text", text: "four" }] },
    ];

    const translated = translateOpenAICompatibleMessages(messages);

    expect(translated.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("is a pure function of its input", () => {
    const messages: AIMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];

    expect(translateOpenAICompatibleMessages(messages)).toEqual(
      translateOpenAICompatibleMessages(messages),
    );
  });
});
