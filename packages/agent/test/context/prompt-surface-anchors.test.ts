import { describe, expect, it } from "vitest";

import {
  completePromptSurfaceAnchors,
  latestCompletePromptSurfaceAnchor,
  promptSurfaceAnchorsAreAvailable,
  PromptSurfaceIntegrityError,
} from "@caelush/agent";

import { assistantMessage, toolResultMessage, userMessage } from "../messages/fixtures.js";

describe("Prompt Surface scoped anchors", () => {
  it("distinguishes same-sequence messages from separate Runs and rejects scope mismatches", () => {
    const run1 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
    const run2 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b";
    const firstTurn = Array.from({ length: 8 }, (_, index) =>
      userMessage({ runId: run1, sequence: index + 1, text: `run1-${String(index + 1)}` }),
    );
    const secondTurn = Array.from({ length: 8 }, (_, index) =>
      userMessage({ runId: run2, sequence: index + 1, text: `run2-${String(index + 1)}` }),
    );
    const messages = [...firstTurn, ...secondTurn];
    const firstAnchor = latestCompletePromptSurfaceAnchor(firstTurn);
    const secondAnchor = latestCompletePromptSurfaceAnchor(secondTurn);

    expect(firstAnchor.sequence).toBe(8);
    expect(secondAnchor.sequence).toBe(8);
    expect(firstAnchor).not.toEqual(secondAnchor);
    expect(promptSurfaceAnchorsAreAvailable(messages, [firstAnchor, secondAnchor])).toBe(true);
    expect(
      promptSurfaceAnchorsAreAvailable(messages, [
        { ...secondAnchor, messageId: firstAnchor.messageId },
      ]),
    ).toBe(false);
    expect(completePromptSurfaceAnchors(messages).size).toBe(16);
  });

  it("keeps Tool batch state inside each ConversationTurn", () => {
    const run1 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
    const run2 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b";
    const firstTurn = [
      userMessage({ runId: run1, sequence: 1 }),
      assistantMessage({ runId: run1, sequence: 2, toolCalls: ["call_a"] }),
      toolResultMessage({ runId: run1, sequence: 3, toolCallId: "call_a" }),
      assistantMessage({ runId: run1, sequence: 4, text: "Run 1 final." }),
    ];
    const secondTurn = [
      userMessage({ runId: run2, sequence: 1 }),
      assistantMessage({ runId: run2, sequence: 2, toolCalls: ["call_b"] }),
      toolResultMessage({ runId: run2, sequence: 3, toolCallId: "call_b" }),
      assistantMessage({ runId: run2, sequence: 4, text: "Run 2 next." }),
    ];

    expect(() => completePromptSurfaceAnchors([...firstTurn, ...secondTurn])).not.toThrow();
    expect(latestCompletePromptSurfaceAnchor([...firstTurn, ...secondTurn])).toMatchObject({
      runId: secondTurn[3]!.message.runId,
      conversationTurnId: secondTurn[3]!.message.conversationTurnId,
      sequence: 4,
    });
  });

  it("still rejects an incomplete Tool batch followed by another assistant in the same Turn", () => {
    const run = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
    const messages = [
      assistantMessage({ runId: run, sequence: 1, toolCalls: ["missing_result"] }),
      assistantMessage({ runId: run, sequence: 2, text: "This cannot follow an open call." }),
    ];

    expect(() => completePromptSurfaceAnchors(messages)).toThrow(PromptSurfaceIntegrityError);
  });
});
