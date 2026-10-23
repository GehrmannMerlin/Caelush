import type { AIToolResultMessage } from "@caelush/ai";
import { describe, expect, it } from "vitest";

import {
  assertToolResultPruningPolicy,
  DEFAULT_TOOL_RESULT_PRUNING,
  omissionMarker,
  PRUNED_TOOL_RESULT_PREFIX,
  pruneSettledToolResult,
} from "../../src/context/materializer/tool-result-pruner.js";

function toolMessage(content: AIToolResultMessage["content"]): AIToolResultMessage {
  return {
    role: "tool",
    toolCallId: "call_1",
    toolName: "read_file",
    content,
    isError: false,
  };
}

const POLICY = { maxBytes: 64, headBytes: 16, tailBytes: 16 };

describe("pruneSettledToolResult", () => {
  it("leaves a result inside the budget untouched, by identity", () => {
    const message = toolMessage("short output");
    const pruned = pruneSettledToolResult(message, POLICY);

    expect(pruned.omittedBytes).toBe(0);
    expect(pruned.message).toBe(message);
  });

  it("keeps a head and a tail and records the omitted bytes", () => {
    const text = `${"H".repeat(40)}${"M".repeat(200)}${"T".repeat(40)}`;
    const pruned = pruneSettledToolResult(toolMessage(text), POLICY);

    expect(pruned.omittedBytes).toBeGreaterThan(0);
    const content = pruned.message.content as string;
    expect(content.startsWith("H".repeat(16))).toBe(true);
    expect(content.endsWith("T".repeat(16))).toBe(true);
    expect(content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(content).toContain(omissionMarker(pruned.omittedBytes));
    // Everything that is not the marker is retained text; the marker accounts for the rest exactly.
    const [retainedHead, retainedTail] = content.split(omissionMarker(pruned.omittedBytes));
    expect(
      Buffer.byteLength(retainedHead!, "utf8") +
        Buffer.byteLength(retainedTail!, "utf8") +
        pruned.omittedBytes,
    ).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("is idempotent: a second pass recognises its own marker", () => {
    const once = pruneSettledToolResult(toolMessage("M".repeat(400)), POLICY);
    const twice = pruneSettledToolResult(once.message, POLICY);

    expect(twice.omittedBytes).toBe(0);
    expect(twice.message).toBe(once.message);
  });

  it("never splits a multi-byte character", () => {
    const text = "汉".repeat(200);
    const pruned = pruneSettledToolResult(toolMessage(text), POLICY);

    expect(pruned.message.content as string).not.toContain("\uFFFD");
    // Every retained character is the original one; the head/tail are whole code points.
    expect((pruned.message.content as string).includes("汉")).toBe(true);
  });

  it("never splits a surrogate pair at the tail budget boundary", () => {
    const text = `${"H".repeat(20)}😀`;
    const pruned = pruneSettledToolResult(toolMessage(text), {
      maxBytes: 10,
      headBytes: 2,
      tailBytes: 4,
    });

    expect((pruned.message.content as string).endsWith("😀")).toBe(true);
  });

  it("leaves a result that carries a non-text part completely alone", () => {
    const message = toolMessage([
      { type: "text", text: "M".repeat(400) },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ] as never);

    const pruned = pruneSettledToolResult(message, POLICY);

    expect(pruned.omittedBytes).toBe(0);
    expect(pruned.message).toBe(message);
  });

  it("prunes an all-text part list in place", () => {
    const pruned = pruneSettledToolResult(
      toolMessage([
        { type: "text", text: "M".repeat(200) },
        { type: "text", text: "short" },
      ]),
      POLICY,
    );

    expect(pruned.omittedBytes).toBeGreaterThan(0);
    const parts = pruned.message.content as readonly { text: string }[];
    expect(parts[0]!.text).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(parts[1]!.text).toBe("short");
  });

  it("ignores a non-tool message", () => {
    const message = { role: "user", content: "M".repeat(400) } as const;
    expect(pruneSettledToolResult(message, POLICY).message).toBe(message);
  });
});

describe("tool result pruning policy", () => {
  it("rejects a policy that leaves no room for the marker", () => {
    expect(() =>
      assertToolResultPruningPolicy({ maxBytes: 100, headBytes: 60, tailBytes: 40 }),
    ).toThrow(RangeError);
    expect(() =>
      assertToolResultPruningPolicy({ maxBytes: 0, headBytes: 1, tailBytes: 1 }),
    ).toThrow(RangeError);
  });

  it("ships a bounded default", () => {
    expect(() => assertToolResultPruningPolicy(DEFAULT_TOOL_RESULT_PRUNING)).not.toThrow();
    expect(DEFAULT_TOOL_RESULT_PRUNING.maxBytes).toBeLessThanOrEqual(16 * 1024);
  });
});
