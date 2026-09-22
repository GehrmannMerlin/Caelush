import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_TOKEN_ESTIMATOR,
  createConversationSelector,
  createStandardAgentMessageProjectorRegistry,
} from "@caelush/agent";
import type {
  AgentConversationSnapshot,
  ConversationSelector,
  ConversationTurn,
  StoredAgentMessage,
  TokenEstimator,
} from "@caelush/agent";

import {
  OBSERVATION_ID,
  OTHER_RUN_ID,
  assistantMessage,
  projectors,
  snapshot,
  stored,
  toolResultMessage,
  turn,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5A — the projected conversation selection primitive. Freeze §117 to §127, §147.
 */

const selector: ConversationSelector = createConversationSelector({ projector: projectors });

/**
 * A byte estimator with a fixed cost per message, so a test can state a budget in "messages"
 * rather than guess at heuristic token counts.
 */
function countingEstimator(costPerMessage: number): TokenEstimator {
  return {
    estimateMessages: (messages) => messages.length * costPerMessage,
  };
}

/** A conversation of one turn built from the given messages. */
function conversationOf(messages: readonly StoredAgentMessage[]): AgentConversationSnapshot {
  return snapshot([turn(messages)]);
}

/** A long text, so the structural estimator has something to count. */
function longText(tokens: number): string {
  return "x".repeat(tokens * 3);
}

describe("Phase 5A selector — everything fits", () => {
  it("selects every message and reports no compaction", () => {
    const conversation = conversationOf([
      userMessage({ text: "hello", sequence: 1 }),
      assistantMessage({ text: "hi", sequence: 2 }),
    ]);
    const selected = selector.select({
      conversation,
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });

    expect(selected.droppedMessageIds).toEqual([]);
    expect(selected.selectedMessageIds).toHaveLength(2);
    expect(selected.requiresCompaction).toBe(false);
    expect(selected.estimatedTokens).toBeGreaterThan(0);
    expect(selected.turns).toHaveLength(1);
    expect(selected.turns[0]?.messages).toHaveLength(2);
  });

  it("measures the projection rather than the durable envelope", () => {
    // Two records with identical semantic content but different envelopes must cost the same.
    // A selector that serialized `AgentMessage` would charge for the message id, the Run, the
    // session, the turn, the audience, the source, the timestamp and the step pointer.
    //
    // `modelProjectionVersion` is deliberately *not* restamped: it selects the projector, so
    // changing it without registering that projector would be a different message, and the
    // registry correctly refuses it.
    const message = userMessage({ text: "same text", sequence: 1 });
    const plain = selector.select({
      conversation: conversationOf([message]),
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    const restamped: StoredAgentMessage = {
      ...message,
      sequence: 999,
      schemaVersion: 7,
      message: {
        ...message.message,
        id: "amsg_0192f5b1-4d3a-7c2e-8a91-ffffffffffff" as never,
        createdAt: 1 as never,
        sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-ffffffffffff" as never,
      },
    };
    const padded = selector.select({
      conversation: conversationOf([restamped]),
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(padded.estimatedTokens).toBe(plain.estimatedTokens);
    expect(plain.estimatedTokens).toBeGreaterThan(0);
    expect(restamped.message.id).not.toBe(message.message.id);
  });

  it("counts a Tool result by its projected content only", () => {
    const conversation = conversationOf([
      userMessage({ text: "go", sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_1",
        toolName: "tool_0",
        projectedContent: longText(100),
        sequence: 3,
      }),
    ]);
    const selected = selector.select({
      conversation,
      maxTokens: 100_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    // The observation pointer and every durable field contribute nothing: 100 tokens of text
    // plus the small user and assistant messages.
    expect(selected.estimatedTokens).toBeGreaterThanOrEqual(100);
    expect(selected.estimatedTokens).toBeLessThan(120);
    expect(OBSERVATION_ID).toBeDefined();
  });
});

describe("Phase 5A selector — the old tail is dropped", () => {
  it("drops from the oldest end until the budget fits", () => {
    // The protected tail begins at the newest model-visible user message, so everything
    // before it is droppable. With a one-token-per-message estimator and a budget of 3, only
    // the protected three survive.
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(200), sequence: 1 }),
      assistantMessage({ text: longText(200), sequence: 2 }),
      assistantMessage({ text: "an earlier answer", sequence: 3 }),
      userMessage({ text: "the latest ask", sequence: 4 }),
      assistantMessage({ text: "the latest answer", sequence: 5 }),
    ];
    const conversation = conversationOf(messages);
    const selected = selector.select({
      conversation,
      maxTokens: 3,
      estimator: countingEstimator(1),
    });

    expect(selected.estimatedTokens).toBeLessThanOrEqual(3);
    expect(selected.droppedMessageIds.length).toBeGreaterThan(0);
    expect(selected.selectedMessageIds.length).toBeGreaterThan(0);

    // Everything dropped is older than everything kept: no holes in the middle.
    const order = messages.map((entry) => entry.message.id as string);
    const lastDropped = Math.max(...selected.droppedMessageIds.map((id) => order.indexOf(id)));
    const firstSelected = Math.min(...selected.selectedMessageIds.map((id) => order.indexOf(id)));
    expect(lastDropped).toBeLessThan(firstSelected);
  });

  it("keeps a contiguous newest suffix rather than a spread of favourites", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(100), sequence: 1 }),
      assistantMessage({ text: longText(100), sequence: 2 }),
      userMessage({ text: longText(100), sequence: 3 }),
      assistantMessage({ text: longText(100), sequence: 4 }),
      userMessage({ text: "the latest ask", sequence: 5 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 2,
      estimator: countingEstimator(1),
    });
    const order = messages.map((entry) => entry.message.id as string);
    const selectedPositions = selected.selectedMessageIds
      .map((id) => order.indexOf(id))
      .sort((left, right) => left - right);
    // A contiguous suffix of the conversation order.
    expect(selectedPositions[selectedPositions.length - 1]).toBe(order.length - 1);
    for (let index = 1; index < selectedPositions.length; index += 1) {
      expect(selectedPositions[index]).toBe((selectedPositions[index - 1] as number) + 1);
    }
  });

  it("always retains the latest model-visible user message", () => {
    const conversation = conversationOf([
      userMessage({ text: longText(500), sequence: 1 }),
      assistantMessage({ text: longText(500), sequence: 2 }),
      userMessage({ text: "the current ask", sequence: 3 }),
    ]);
    const selected = selector.select({
      conversation,
      maxTokens: 1,
      estimator: countingEstimator(1),
    });
    const latest = conversation.turns[0]?.messages[2]?.message.id;
    expect(selected.selectedMessageIds).toContain(latest);
    expect(selected.droppedMessageIds).not.toContain(latest);
  });

  it("partitions every message into exactly one of the two id lists", () => {
    const conversation = conversationOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "a", sequence: 2 }),
      userMessage({ sequence: 3 }),
    ]);
    const all = conversation.turns.flatMap((entry) =>
      entry.messages.map((message) => message.message.id),
    );
    for (const maxTokens of [0, 1, 5, 1000]) {
      const selected = selector.select({
        conversation,
        maxTokens,
        estimator: countingEstimator(1),
      });
      const union = [...selected.selectedMessageIds, ...selected.droppedMessageIds];
      expect(union.sort()).toEqual([...all].sort());
      // No id appears in both lists.
      const overlap = selected.selectedMessageIds.filter((id) =>
        selected.droppedMessageIds.includes(id),
      );
      expect(overlap).toEqual([]);
    }
  });
});

describe("Phase 5A selector — model-invisible messages cost nothing (freeze §123)", () => {
  it("charges zero for a hidden message and never drops it", () => {
    const hidden = stored(userMessage({ text: longText(5000) }).message, 1, false);
    const visible = userMessage({ text: "short", sequence: 2 });
    const conversation = conversationOf([hidden, visible]);

    const selected = selector.select({
      conversation,
      maxTokens: 10,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });

    // The hidden message is retained rather than dropped: dropping it would free no budget.
    expect(selected.selectedMessageIds).toContain(hidden.message.id);
    expect(selected.droppedMessageIds).not.toContain(hidden.message.id);
    // And it contributed nothing, so a tiny budget still fits.
    expect(selected.estimatedTokens).toBeLessThanOrEqual(10);
  });

  it("produces the same estimate with and without hidden material", () => {
    const visible = userMessage({ text: "same", sequence: 1 });
    const hidden = stored(assistantMessage({ text: longText(999) }).message, 2, false);

    const withoutHidden = selector.select({
      conversation: conversationOf([visible]),
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    const withHidden = selector.select({
      conversation: conversationOf([visible, hidden]),
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(withHidden.estimatedTokens).toBe(withoutHidden.estimatedTokens);
  });

  it("never drops a debug-only or transcript-only message to free budget", () => {
    const hidden = stored(userMessage({ text: longText(1000) }).message, 1, false);
    const visible = userMessage({ text: longText(1000), sequence: 2 });
    const selected = selector.select({
      conversation: conversationOf([hidden, visible]),
      maxTokens: 0,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(selected.selectedMessageIds).toContain(hidden.message.id);
  });
});

describe("Phase 5A selector — Tool execution unit atomicity (freeze §125)", () => {
  it("drops a Tool call and its result together, never one without the other", () => {
    const old: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_1",
        toolName: "tool_0",
        projectedContent: longText(400),
        sequence: 3,
      }),
      userMessage({ text: "latest", sequence: 4 }),
    ];
    const conversation = conversationOf(old);
    const selected = selector.select({
      conversation,
      maxTokens: 40,
      estimator: countingEstimator(1),
    });

    const callId = old[1]?.message.id as string;
    const resultId = old[2]?.message.id as string;
    const callSelected = selected.selectedMessageIds.includes(callId as never);
    const resultSelected = selected.selectedMessageIds.includes(resultId as never);
    // The unit is atomic: either both survived or neither did.
    expect(callSelected).toBe(resultSelected);
  });

  it("keeps a multi-tool unit whole", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 4 }),
      userMessage({ text: "latest", sequence: 5 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 3,
      estimator: countingEstimator(1),
    });

    const unitIds = [messages[1]?.message.id, messages[2]?.message.id, messages[3]?.message.id];
    const survivors = unitIds.filter((id) => selected.selectedMessageIds.includes(id as never));
    expect(survivors.length === 0 || survivors.length === 3).toBe(true);
  });

  it("never leaves an orphan result or an unanswered call", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      userMessage({ text: "latest", sequence: 4 }),
    ];
    for (const maxTokens of [0, 1, 2, 3, 4, 100]) {
      const selected = selector.select({
        conversation: conversationOf(messages),
        maxTokens,
        estimator: countingEstimator(1),
      });
      const selectedSet = new Set<string>(selected.selectedMessageIds);
      const callIn = selectedSet.has(messages[1]?.message.id ?? "");
      const resultIn = selectedSet.has(messages[2]?.message.id ?? "");
      expect(callIn).toBe(resultIn);
    }
  });
});

describe("Phase 5A selector — the latest OPEN unit is retained (freeze §126)", () => {
  it("never drops an open execution unit", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ text: longText(400), sequence: 2 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 3 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 1,
      estimator: countingEstimator(1),
    });
    const openUnitMessage = messages[2]?.message.id;
    expect(selected.selectedMessageIds).toContain(openUnitMessage);
    expect(selected.droppedMessageIds).not.toContain(openUnitMessage);
  });

  it("reports requiresCompaction when the protected material still does not fit", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 1,
      estimator: countingEstimator(1),
    });
    expect(selected.requiresCompaction).toBe(true);
    // The report is not a decision: nothing was summarized and no message was invented.
    expect(selected.selectedMessageIds).toHaveLength(2);
  });

  it("does not report compaction when the protected material fits", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: "fits", sequence: 1 }),
      assistantMessage({ text: "answer", sequence: 2 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 100,
      estimator: countingEstimator(1),
    });
    expect(selected.requiresCompaction).toBe(false);
  });

  it("reports no compaction for an empty conversation", () => {
    const selected = selector.select({
      conversation: snapshot([]),
      maxTokens: 0,
      estimator: countingEstimator(1),
    });
    expect(selected.turns).toEqual([]);
    expect(selected.selectedMessageIds).toEqual([]);
    expect(selected.droppedMessageIds).toEqual([]);
    expect(selected.estimatedTokens).toBe(0);
    expect(selected.requiresCompaction).toBe(false);
  });
});

describe("Phase 5A selector — stability and determinism", () => {
  it("returns the same result for the same input", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      userMessage({ text: "latest", sequence: 4 }),
    ];
    const conversation = conversationOf(messages);
    const input = { conversation, maxTokens: 5, estimator: countingEstimator(1) };
    const first = selector.select(input);
    const second = selector.select(input);
    expect(second).toEqual(first);
  });

  it("keeps both id lists in conversation order", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ text: "a", sequence: 2 }),
      userMessage({ text: "b", sequence: 3 }),
      assistantMessage({ text: "c", sequence: 4 }),
      userMessage({ text: "d", sequence: 5 }),
    ];
    const selected = selector.select({
      conversation: conversationOf(messages),
      maxTokens: 3,
      estimator: countingEstimator(1),
    });
    const order = messages.map((entry) => entry.message.id as string);

    const selectedPositions = selected.selectedMessageIds.map((id) => order.indexOf(id));
    expect(selectedPositions).toEqual([...selectedPositions].sort((a, b) => a - b));
    const droppedPositions = selected.droppedMessageIds.map((id) => order.indexOf(id));
    expect(droppedPositions).toEqual([...droppedPositions].sort((a, b) => a - b));
  });

  it("selects the same ids for a given budget regardless of the estimator instance", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ text: longText(400), sequence: 1 }),
      assistantMessage({ text: "a", sequence: 2 }),
      userMessage({ text: "latest", sequence: 3 }),
    ];
    const conversation = conversationOf(messages);
    const first = selector.select({ conversation, maxTokens: 2, estimator: countingEstimator(1) });
    const second = selector.select({ conversation, maxTokens: 2, estimator: countingEstimator(1) });
    expect(second.selectedMessageIds).toEqual(first.selectedMessageIds);
    expect(second.droppedMessageIds).toEqual(first.droppedMessageIds);
  });

  it("refuses an invalid budget rather than guessing one", () => {
    const conversation = conversationOf([userMessage({ sequence: 1 })]);
    for (const maxTokens of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        selector.select({ conversation, maxTokens, estimator: countingEstimator(1) }),
      ).toThrow(RangeError);
    }
    expect(() =>
      selector.select({ conversation, maxTokens: 0, estimator: countingEstimator(1) }),
    ).not.toThrow();
  });

  it("accepts any registry that implements the frozen projector contract", () => {
    // The selector depends on the registry, not on the standard projectors, so a host with a
    // custom message type composes its own and the selector is unchanged.
    const custom = createConversationSelector({
      projector: createStandardAgentMessageProjectorRegistry(),
    });
    const selected = custom.select({
      conversation: conversationOf([userMessage({ sequence: 1 })]),
      maxTokens: 100,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(selected.selectedMessageIds).toHaveLength(1);
  });
});

describe("Phase 5A selector — multi-turn sessions", () => {
  it("may drop an older turn and keeps the current turn's protected tail", () => {
    // Turn 1 is the earlier Run of the Session; turn 2 is the current one. Everything in turn 1
    // is droppable; the current ask in turn 2 is not.
    const older: ConversationTurn = turn(
      [
        userMessage({ text: longText(900), sequence: 1 }),
        assistantMessage({ text: longText(900), sequence: 2 }),
      ],
      { openedAt: 1 },
    );
    const newer: ConversationTurn = turn(
      [userMessage({ text: "the current ask", runId: OTHER_RUN_ID, sequence: 1 })],
      { runId: OTHER_RUN_ID, openedAt: 2 },
    );

    const selected = selector.select({
      conversation: snapshot([older, newer], { runId: OTHER_RUN_ID }),
      maxTokens: 1,
      estimator: countingEstimator(1),
    });

    const retained = selected.turns.flatMap((entry) =>
      entry.messages.map((message) => message.message.id),
    );
    expect(retained).toContain(newer.messages[0]?.message.id);
    // The older turn's messages are all gone, and none of them leaked into a partial turn.
    for (const message of older.messages) {
      expect(selected.droppedMessageIds).toContain(message.message.id);
    }
    // Turn order is preserved in the result.
    const remainingRunIds = selected.turns.map((entry) => entry.runId);
    expect(remainingRunIds).toEqual([OTHER_RUN_ID]);
  });

  it("keeps both turns when both fit", () => {
    const older: ConversationTurn = turn([userMessage({ text: "old", sequence: 1 })], {
      openedAt: 1,
    });
    const newer: ConversationTurn = turn(
      [userMessage({ text: "new", runId: OTHER_RUN_ID, sequence: 1 })],
      { runId: OTHER_RUN_ID, openedAt: 2 },
    );
    const selected = selector.select({
      conversation: snapshot([older, newer], { runId: OTHER_RUN_ID }),
      maxTokens: 1000,
      estimator: countingEstimator(1),
    });
    expect(selected.turns).toHaveLength(2);
    expect(selected.droppedMessageIds).toEqual([]);
  });
});
