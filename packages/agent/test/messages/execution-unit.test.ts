import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_TOKEN_ESTIMATOR,
  buildConversationExecutionUnits,
  buildExecutionUnits,
  executionUnitId,
  isCompactionCandidate,
} from "@caelush/agent";
import type { ExecutionUnit, StoredAgentMessage } from "@caelush/agent";

import {
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  factory,
  projectors,
  stored,
  toolResultMessage,
  turn,
  turnIdFor,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5A — `ExecutionUnit` identity and grouping. Freeze §111 to §116, §146.
 *
 * ```text
 * ConversationTurn   one user interaction
 * ExecutionUnit      one assistant Tool-call message plus the results that answer it
 * ```
 */

const unitsOf = (messages: readonly StoredAgentMessage[]): readonly ExecutionUnit[] =>
  buildExecutionUnits(turn(messages), STRUCTURAL_TOKEN_ESTIMATOR, projectors);

describe("Phase 5A ExecutionUnit — what does and does not open a unit", () => {
  it("produces no unit for a message with no Tool calls", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "just an answer", sequence: 2 }),
    ]);
    expect(units).toEqual([]);
  });

  it("produces no unit for a user or Tool result message alone", () => {
    expect(unitsOf([userMessage({ sequence: 1 })])).toEqual([]);
    expect(unitsOf([toolResultMessage({ sequence: 1 })])).toEqual([]);
  });

  it("opens exactly one unit for one assistant Tool-call message", () => {
    const conversation: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ];
    // The identity is read from the stored message the unit actually covers, not from a
    // second fixture built for the assertion.
    const units = unitsOf(conversation);
    expect(units).toHaveLength(1);
    expect(units[0]?.assistantMessageId).toBe(conversation[1]?.message.id);
  });
});

describe("Phase 5A ExecutionUnit — OPEN and CLOSED", () => {
  it("reports OPEN while a result is missing", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ]);
    expect(units[0]?.status).toBe("OPEN");
    expect(units[0]?.closedAt).toBeUndefined();
  });

  it("reports CLOSED once every announced call is answered", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ]);
    expect(units[0]?.status).toBe("CLOSED");
    expect(units[0]?.closedAt).toBeDefined();
  });

  it("reports OPEN for a partially answered multi-tool batch", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2", "call_3"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 4 }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]?.status).toBe("OPEN");
    expect(units[0]?.toolCallIds).toEqual(["call_1", "call_2", "call_3"]);
    expect(units[0]?.toolResultMessageIds).toHaveLength(2);
  });

  it("reports CLOSED when all results have arrived", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 4 }),
    ]);
    expect(units[0]?.status).toBe("CLOSED");
    expect(units[0]?.toolResultMessageIds).toHaveLength(2);
  });

  it("groups two separate Tool turns into two units", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      assistantMessage({ toolCalls: ["call_2"], sequence: 4 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_0", sequence: 5 }),
    ]);
    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.status)).toEqual(["CLOSED", "CLOSED"]);
    expect(units[0]?.id).not.toBe(units[1]?.id);
  });

  it("attributes results by toolCallId rather than by adjacency", () => {
    // A result for an id this unit never announced belongs to another unit or to none. It
    // must not be absorbed by position, which is how a Tool's output ends up paired with the
    // wrong call.
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_other", toolName: "tool_0", sequence: 3 }),
    ]);
    expect(units[0]?.status).toBe("OPEN");
    expect(units[0]?.toolResultMessageIds).toEqual([]);
  });
});

describe("Phase 5A ExecutionUnit — identity is derived, never positional (freeze §112)", () => {
  it("derives the id from the Run and the assistant message", () => {
    const conversation: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ];
    const units = unitsOf(conversation);
    const assistantId = conversation[1]?.message.id;
    expect(units[0]?.id).toBe(executionUnitId(RUN_ID as never, assistantId as never));
    expect(units[0]?.id).toBe(`${RUN_ID}:execution:${String(assistantId)}`);
  });

  it("keeps the same id when unrelated messages are inserted earlier", () => {
    // This is the property an array index cannot have: a compaction or a backfill shifts
    // every position, and a durable pointer that silently renames itself is worse than none.
    const original: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ];
    const padded: readonly StoredAgentMessage[] = [
      userMessage({ text: "an earlier message", sequence: 1 }),
      userMessage({ text: "another", sequence: 2 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 3 }),
    ];
    // Identity comes from the assistant message, so the *same* stored message moved later in
    // the turn must keep the same unit id.
    const subject = padded[2];
    const before = buildExecutionUnits(
      turn([original[1] as never]),
      STRUCTURAL_TOKEN_ESTIMATOR,
      projectors,
    );
    const shifted = buildExecutionUnits(
      turn([subject as never]),
      STRUCTURAL_TOKEN_ESTIMATOR,
      projectors,
    );
    expect(before[0]?.id).toBe(`${RUN_ID}:execution:${before[0]?.assistantMessageId ?? ""}`);
    expect(shifted[0]?.id).toBe(`${RUN_ID}:execution:${shifted[0]?.assistantMessageId ?? ""}`);
    // Neither id embeds the message's position in the turn.
    expect(before[0]?.id).not.toMatch(/:execution:\d+$/);
    expect(shifted[0]?.id).not.toMatch(/:execution:\d+$/);
  });

  it("never uses an array index as identity", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      assistantMessage({ toolCalls: ["call_2"], sequence: 4 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_0", sequence: 5 }),
    ]);
    for (const unit of units) {
      expect(unit.id).not.toMatch(/:execution:\d+$/);
      expect(unit.id).toContain(unit.assistantMessageId);
    }
  });
});

describe("Phase 5A ExecutionUnit — source range and message identities", () => {
  it("records the inclusive stored-sequence range the unit covers", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 4 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 7 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 9 }),
    ]);
    expect(units[0]?.sourceSequenceFrom).toBe(4);
    expect(units[0]?.sourceSequenceTo).toBe(9);
  });

  it("ends the range at the assistant message while the unit is open", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 5 }),
      userMessage({ text: "still waiting", sequence: 6 }),
    ]);
    expect(units[0]?.sourceSequenceFrom).toBe(5);
    expect(units[0]?.sourceSequenceTo).toBe(5);
  });

  it("names result messages by identity, not by position", () => {
    const first = toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 });
    const second = toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 4 });
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 2 }),
      first,
      second,
    ]);
    expect(units[0]?.toolResultMessageIds).toEqual([first.message.id, second.message.id]);
  });

  it("carries the Run and the conversation turn", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ]);
    expect(units[0]?.runId).toBe(RUN_ID);
    expect(units[0]?.conversationTurnId).toBe(units[0]?.conversationTurnId);
  });
});

describe("Phase 5A ExecutionUnit — model visibility governs grouping", () => {
  it("does not open a unit for a model-invisible assistant message", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      stored(assistantMessage({ toolCalls: ["call_1"] }).message, 2, false),
    ]);
    expect(units).toEqual([]);
  });

  it("does not let a hidden result close a visible unit", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      stored(toolResultMessage({ toolCallId: "call_1", toolName: "tool_0" }).message, 3, false),
    ]);
    expect(units[0]?.status).toBe("OPEN");
    expect(units[0]?.toolResultMessageIds).toEqual([]);
  });

  it("does not let a hidden message between a call and its result break the unit", () => {
    const visible = toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 4 });
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      stored(userMessage({ text: "ui only" }).message, 3, false),
      visible,
    ]);
    expect(units[0]?.status).toBe("CLOSED");
    expect(units[0]?.toolResultMessageIds).toEqual([visible.message.id]);
  });
});

describe("Phase 5A ExecutionUnit — compaction invariant (freeze §116)", () => {
  it("marks only a CLOSED, fully answered unit as a compaction candidate", () => {
    const closed = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ]);
    expect(isCompactionCandidate(closed[0] as ExecutionUnit)).toBe(true);
  });

  it("refuses an open unit", () => {
    const open = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ]);
    expect(isCompactionCandidate(open[0] as ExecutionUnit)).toBe(false);
  });

  it("does not trust a CLOSED claim with a missing result", () => {
    // `status` is a claim; the counts are the evidence. A status-only check would let a
    // half-answered unit be compacted away and the model would never learn the outcome.
    const unit: ExecutionUnit = {
      id: "unit",
      runId: RUN_ID as never,
      conversationTurnId: "cturn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
      status: "CLOSED",
      assistantMessageId: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000002" as never,
      toolCallIds: ["call_1", "call_2"],
      toolResultMessageIds: ["amsg_0192f5b1-4d3a-7c2e-8a91-000000000003" as never],
      projectedTokenEstimate: 10,
      createdAt: 1 as never,
      closedAt: 2 as never,
    };
    expect(isCompactionCandidate(unit)).toBe(false);
  });

  it("measures the projected cost rather than the durable envelope", () => {
    const units = unitsOf([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_1",
        toolName: "tool_0",
        projectedContent: "x".repeat(300),
        sequence: 3,
      }),
    ]);
    // 300 ASCII bytes at the 3-bytes-per-token heuristic is 100 tokens, plus the assistant
    // tool-call's tool name. Identity, Run, session, audience and the observation pointer
    // contribute nothing, which they could not if the unit measured its durable JSON.
    expect(units[0]?.projectedTokenEstimate).toBeGreaterThanOrEqual(100);
    expect(units[0]?.projectedTokenEstimate).toBeLessThan(120);
  });

  it("costs nothing for a unit whose messages the model cannot see", () => {
    const units = buildConversationExecutionUnits(
      [turn([stored(assistantMessage({ toolCalls: ["call_1"] }).message, 1, false)])],
      STRUCTURAL_TOKEN_ESTIMATOR,
      projectors,
    );
    expect(units).toEqual([]);
  });
});

describe("Phase 5A ExecutionUnit — determinism", () => {
  it("produces the same units for the same turn", () => {
    const messages = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ];
    const first = buildExecutionUnits(turn(messages), STRUCTURAL_TOKEN_ESTIMATOR, projectors);
    const second = buildExecutionUnits(turn(messages), STRUCTURAL_TOKEN_ESTIMATOR, projectors);
    expect(second).toEqual(first);
  });

  it("keeps the unit independent of the factory that created its messages", () => {
    // Identity comes from the stored message, so two messages with identical content but
    // different identities produce different units. One factory is used for both so the
    // difference is the message, not the sequence.
    const messageFactory = factory();
    const build = () =>
      messageFactory.createAssistant({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: { kind: "MODEL", callId: "llm_x" },
        content: [{ type: "TOOL_CALL", toolCallId: "call_1", toolName: "tool_0", input: {} }],
        model: {
          kind: "MODEL_TURN",
          callId: "llm_x",
          model: { provider: "p", model: "m" },
          finishReason: "TOOL_CALLS",
        },
      });

    const firstAssistant = build();
    const secondAssistant = build();
    expect(firstAssistant.id).not.toBe(secondAssistant.id);
    // Everything except the identity is identical.
    expect(secondAssistant.content).toEqual(firstAssistant.content);

    const first = buildExecutionUnits(
      turn([stored(firstAssistant, 1)]),
      STRUCTURAL_TOKEN_ESTIMATOR,
      projectors,
    );
    const second = buildExecutionUnits(
      turn([stored(secondAssistant, 1)]),
      STRUCTURAL_TOKEN_ESTIMATOR,
      projectors,
    );
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });
});
