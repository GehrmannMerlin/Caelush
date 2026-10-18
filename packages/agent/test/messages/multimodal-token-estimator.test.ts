import { describe, expect, it } from "vitest";

import { STRUCTURAL_TOKEN_ESTIMATOR } from "@caelush/agent";
import type { AIConversationMessage } from "@caelush/ai";

describe("structural conversation token estimator with images", () => {
  it("charges user and Tool-result images a non-zero conservative estimate", () => {
    const textOnlyUser: AIConversationMessage = { role: "user", content: "look" };
    const imageUser: AIConversationMessage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ],
    };
    const imageToolResult: AIConversationMessage = {
      role: "tool",
      toolCallId: "call_1",
      toolName: "read_attachment",
      content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }],
      isError: false,
    };

    expect(STRUCTURAL_TOKEN_ESTIMATOR.estimateMessages([imageUser])).toBeGreaterThan(
      STRUCTURAL_TOKEN_ESTIMATOR.estimateMessages([textOnlyUser]),
    );
    expect(STRUCTURAL_TOKEN_ESTIMATOR.estimateMessages([imageToolResult])).toBeGreaterThan(0);
  });
});
