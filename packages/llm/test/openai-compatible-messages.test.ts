import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../src/index.js";
import { toAIMessage } from "../src/compatibility/request-projection.js";
import { toAIModelRef } from "../src/compatibility/legacy-json.js";

/**
 * The SDK-facing message translation moved to
 * `@caelush/ai/adapters/openai-compatible`, where it is covered by
 * `packages/ai/test/adapters/openai-compatible/message-translator.test.ts`.
 *
 * What remains a legacy responsibility — and what this file now locks — is the
 * projection from the legacy message contract onto the frozen AI message contract.
 */
describe("OpenAI-compatible legacy message projection", () => {
  it("projects system, empty system, and user messages", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are precise." },
      { role: "system", content: "" },
      { role: "user", content: "Hello" },
    ];

    expect(messages.map(toAIMessage)).toEqual([
      { role: "system", content: "You are precise." },
      { role: "system", content: "" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("preserves assistant text part order", () => {
    expect(
      toAIMessage({
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: " second" },
      ],
    });
  });

  it("projects an assistant tool-only message without synthetic text", () => {
    expect(
      toAIMessage({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: {} }],
      }),
    ).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: {} }],
    });
  });

  it("projects assistant text plus a tool call and both tool result states", () => {
    expect(
      toAIMessage({
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
      }),
    ).toEqual({
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
    });

    expect(
      toAIMessage({
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "file contents",
        isError: false,
      }),
    ).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "file contents",
      isError: false,
    });

    expect(
      toAIMessage({
        role: "tool",
        toolCallId: "call-2",
        toolName: "read_file",
        content: "permission denied",
        isError: true,
      }),
    ).toEqual({
      role: "tool",
      toolCallId: "call-2",
      toolName: "read_file",
      content: "permission denied",
      isError: true,
    });
  });

  it("preserves a complete multi-turn model history in order", () => {
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

    const projected = history.map(toAIMessage);
    expect(projected).toHaveLength(4);
    expect(projected.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("drops the durable artifact pointer, which is not provider input", () => {
    const projected = toAIMessage({
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "contents",
      isError: false,
      rawArtifactRef: "artifact-1",
    });

    expect(projected).not.toHaveProperty("rawArtifactRef");
    expect(JSON.stringify(projected)).not.toContain("artifact-1");
  });

  it("projects the model reference without inventing a baseUrl", () => {
    expect(toAIModelRef({ provider: "compat-fixture", model: "m" })).toEqual({
      provider: "compat-fixture",
      model: "m",
    });
    expect(
      toAIModelRef({ provider: "compat-fixture", model: "m", baseUrl: "http://legacy.example" }),
    ).toEqual({
      provider: "compat-fixture",
      model: "m",
      baseUrl: "http://legacy.example",
    });
  });
});
