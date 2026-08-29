import { describe, expect, it } from "vitest";
import { toLLMToolResultMessages, ToolBatchResultConversionError } from "../src/index.js";

const requests = [
  { externalCallId: "call_b", toolName: "echo_value" as const, args: {} },
  { externalCallId: "call_a", toolName: "echo_value" as const, args: {} },
];

describe("Tool Batch to LLM result conversion", () => {
  it("preserves request source order and excludes durable details", () => {
    const results = [
      {
        kind: "TOOL_RESULT" as const,
        externalCallId: "call_b",
        toolName: "echo_value" as const,
        content: "B",
        isError: false,
        details: { secret: "CAELUSH_TOOL_DETAILS_SECRET_42" },
      },
      {
        kind: "TOOL_RESULT" as const,
        externalCallId: "call_a",
        toolName: "echo_value" as const,
        content: "A",
        isError: true,
      },
    ];

    const messages = toLLMToolResultMessages(requests, results);

    expect(messages).toEqual([
      { role: "tool", toolCallId: "call_b", toolName: "echo_value", content: "B", isError: false },
      { role: "tool", toolCallId: "call_a", toolName: "echo_value", content: "A", isError: true },
    ]);
    expect(JSON.stringify(messages)).not.toContain("CAELUSH_TOOL_DETAILS_SECRET_42");
  });

  it("rejects a result batch that does not match source order", () => {
    expect(() =>
      toLLMToolResultMessages(requests, [
        {
          kind: "TOOL_RESULT",
          externalCallId: "wrong",
          toolName: "echo_value",
          content: "bad",
          isError: true,
        },
        {
          kind: "TOOL_RESULT",
          externalCallId: "call_a",
          toolName: "echo_value",
          content: "A",
          isError: false,
        },
      ]),
    ).toThrow(ToolBatchResultConversionError);
  });
});
