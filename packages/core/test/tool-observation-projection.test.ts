import { describe, expect, it } from "vitest";
import { toLLMToolResultMessages } from "../src/agent-tool-batch.js";

describe("tool result model projection", () => {
  it("bounds large settled output while preserving source call identity", () => {
    const message = toLLMToolResultMessages(
      [{ externalCallId: "call-1", toolName: "exec_command", args: {} }],
      [
        {
          kind: "TOOL_RESULT",
          externalCallId: "call-1",
          toolName: "exec_command",
          content: `${"head\n".repeat(100_000)}tail-secret-marker`,
          isError: false,
        },
      ],
    )[0]!;

    expect(message.toolCallId).toBe("call-1");
    expect(message.content.length).toBeLessThan(40_000);
    expect(message.content).toContain("output omitted");
    expect(message.content).toContain("tail-secret-marker");
  });
});
