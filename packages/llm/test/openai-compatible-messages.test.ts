import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../src/index.js";
import { toAISDKMessages } from "../src/providers/openai-compatible/messages.js";

describe("OpenAI-compatible message conversion", () => {
  it("converts system, empty system, and user messages", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are precise." },
      { role: "system", content: "" },
      { role: "user", content: "Hello" },
    ];

    expect(toAISDKMessages(messages)).toEqual([
      { role: "system", content: "You are precise." },
      { role: "system", content: "" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("preserves assistant text part order", () => {
    expect(
      toAISDKMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: " second" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
      },
    ]);
  });

  it("converts an assistant tool-only message without synthetic text", () => {
    expect(
      toAISDKMessages([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: {} }],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: {} }],
      },
    ]);
  });

  it("converts assistant text plus a tool call and both tool result states", () => {
    expect(
      toAISDKMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "file contents",
          isError: false,
        },
        {
          role: "tool",
          toolCallId: "call-2",
          toolName: "read_file",
          content: "permission denied",
          isError: true,
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "read_file",
            output: { type: "error-text", value: "permission denied" },
          },
        ],
      },
    ]);
  });

  it("preserves a complete multi-turn model history", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "contents",
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "The file says contents." }] },
    ];

    expect(toAISDKMessages(history)).toHaveLength(4);
    expect(toAISDKMessages(history)[1]).toMatchObject({ role: "assistant" });
    expect(toAISDKMessages(history)[2]).toMatchObject({ role: "tool" });
  });
});
