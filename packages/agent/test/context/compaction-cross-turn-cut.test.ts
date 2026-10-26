import { describe, expect, it } from "vitest";

import { createRunId } from "@caelush/protocol";
import { createLongOpenTurnFixture } from "./support/deep-compaction-fixtures.js";
import {
  agentMessageId,
  conversationTurnId,
  createContextCompactionPlanner,
  type ContextHistoryIndex,
  type ContextHistoryUnit,
  type ContextMessageRef,
  type ContextPolicy,
  type ToolProtocolUnit,
} from "@caelush/agent";

const runId = createRunId();

function refs(
  turn: ReturnType<typeof conversationTurnId>,
  from: number,
  to: number,
  tokenEstimate?: number,
): ContextMessageRef[] {
  const messages: ContextMessageRef[] = [];
  for (let sequence = from; sequence <= to; sequence += 1) {
    messages.push({
      messageId: agentMessageId(`amsg_${String(sequence)}`),
      runId,
      conversationTurnId: turn,
      sequence,
      ...(tokenEstimate === undefined ? {} : { tokenEstimate }),
    });
  }
  return messages;
}

function turnUnit(input: {
  readonly turn: string;
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly tokens: number;
  readonly status?: "OPEN" | "CLOSED";
}): ContextHistoryUnit {
  const turn = conversationTurnId(input.turn);
  const status = input.status ?? "CLOSED";
  return {
    id: input.id,
    kind: "CONVERSATION_TURN",
    status,
    messages: refs(turn, input.from, input.to),
    tokenEstimate: input.tokens,
    atomicGroupId: input.turn,
    compactionEligible: status === "CLOSED",
  };
}

function protocolUnit(
  turn: string,
  id: string,
  sequence: number,
  tokens: number,
): ToolProtocolUnit {
  return {
    id,
    kind: "TOOL_PROTOCOL",
    status: "CLOSED",
    messages: refs(conversationTurnId(turn), sequence, sequence + 2, Math.floor(tokens / 3)),
    tokenEstimate: tokens,
    atomicGroupId: id,
    compactionEligible: true,
    sourceAssistantMessageId: agentMessageId(`amsg_${id}`),
    toolCallIds: [`call_${id}`],
    toolResultMessageIds: [agentMessageId(`amsg_${id}_result`)],
  };
}

function history(units: readonly ContextHistoryUnit[]): ContextHistoryIndex {
  return {
    units,
    openUnits: units.filter((unit) => unit.status === "OPEN"),
    closedUnits: units.filter((unit) => unit.status === "CLOSED"),
    estimatedTokens: units.reduce((total, unit) => total + unit.tokenEstimate, 0),
  };
}

function policy(
  targetRecentTailTokens: number,
  minRecentTailTokens: number,
  allowCurrentTurnPrefix = false,
): ContextPolicy {
  return {
    targetRecentTailTokens,
    minRecentTailTokens,
    allowCurrentTurnPrefix,
  } as ContextPolicy;
}

describe("cross-turn compaction cut", () => {
  it("chooses a legal protocol cut over an oversized full-turn tail across Runs", () => {
    const oldTurn = weightedTurnUnit({
      run: createRunId(),
      turn: "cturn_huge_old_run",
      id: "huge-old-run",
      count: 10,
      tokens: 1_054_914,
    });
    const compressibleTurn = weightedTurnUnit({
      run: createRunId(),
      turn: "cturn_large_tool_run",
      id: "large-tool-run",
      count: 372,
      tokens: 276_441,
    });
    const continuedTurns = [
      weightedTurnUnit({
        run: createRunId(),
        turn: "cturn_continue_a",
        id: "continue-a",
        count: 1,
        tokens: 147,
      }),
      weightedTurnUnit({
        run: createRunId(),
        turn: "cturn_continue_b",
        id: "continue-b",
        count: 1,
        tokens: 147,
      }),
    ];
    const currentTurn = weightedTurnUnit({
      run: createRunId(),
      turn: "cturn_current",
      id: "current",
      count: 1,
      tokens: 147,
      status: "OPEN",
    });
    const compressibleMessages = compressibleTurn.messages;
    const protocols: ToolProtocolUnit[] = [];
    for (let firstSequence = 2; firstSequence <= 352; firstSequence += 10) {
      const messages = compressibleMessages.slice(firstSequence - 1, firstSequence + 2);
      const first = messages[0];
      const last = messages.at(-1);
      if (first === undefined || last === undefined || messages.length !== 3) continue;
      protocols.push({
        id: `tool-protocol:${first.messageId}`,
        kind: "TOOL_PROTOCOL",
        status: "CLOSED",
        messages,
        tokenEstimate: messages.reduce((total, message) => total + (message.tokenEstimate ?? 0), 0),
        atomicGroupId: String(first.messageId),
        compactionEligible: true,
        sourceAssistantMessageId: first.messageId,
        toolCallIds: [`call_${firstSequence}`],
        toolResultMessageIds: [last.messageId],
      });
    }
    const openObligation: ToolProtocolUnit = {
      id: "tool-protocol:open-obligation",
      kind: "TOOL_PROTOCOL",
      status: "OPEN",
      messages: currentTurn.messages,
      tokenEstimate: currentTurn.tokenEstimate,
      atomicGroupId: "open-obligation",
      compactionEligible: false,
      sourceAssistantMessageId: currentTurn.messages[0]!.messageId,
      toolCallIds: ["call_open"],
      toolResultMessageIds: [],
    };
    const turns = [oldTurn, compressibleTurn, ...continuedTurns, currentTurn];
    const units = [
      oldTurn,
      compressibleTurn,
      ...protocols,
      ...continuedTurns,
      currentTurn,
      openObligation,
    ];
    const indexedHistory: ContextHistoryIndex = {
      units,
      openUnits: [currentTurn, openObligation],
      closedUnits: [oldTurn, compressibleTurn, ...protocols, ...continuedTurns],
      estimatedTokens: turns.reduce((total, unit) => total + unit.tokenEstimate, 0),
    };

    const plan = createContextCompactionPlanner().plan({
      history: indexedHistory,
      policy: policy(20_000, 8_000),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).not.toBeNull();
    expect(plan?.retainedTokens).toBeLessThan(30_000);
    expect(plan?.cut.kind).toBe("PROTOCOL_SAFE_SPLIT");
    expect(plan?.retainedTokens).toBeGreaterThanOrEqual(8_000);
    expect(plan?.minimumRetainedTokens).toBeLessThan(8_000);
    expect(plan?.selectedUnitIds).not.toContain(openObligation.id);
    expect(plan?.sourceCoverageDelta.length).toBeGreaterThan(1);
  });

  it("folds only closed Tool batches and retains the final incomplete obligation", () => {
    const fixture = createLongOpenTurnFixture();
    const plan = createContextCompactionPlanner().plan({
      history: fixture.history,
      policy: policy(256, 64, true),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).not.toBeNull();
    const selectedIds = new Set(plan?.selectedUnitIds);
    const protocols = fixture.history.units.filter((unit) => unit.kind === "TOOL_PROTOCOL");
    const selectedProtocols = protocols.filter((unit) => selectedIds.has(unit.id));
    expect(selectedProtocols.length).toBeGreaterThan(0);
    expect(selectedProtocols.every((unit) => unit.status === "CLOSED")).toBe(true);
    expect(selectedProtocols.every((unit) => unit.compactionEligible)).toBe(true);
    expect(
      selectedProtocols.flatMap((unit) => unit.messages).every((message) => message.sequence < 202),
    ).toBe(true);
    expect(plan?.sourceCoverageDelta).toHaveLength(1);
    expect(plan?.sourceCoverageDelta?.[0]?.lastSequence).toBeLessThan(202);
  });

  it("folds the full closed prefix across turns while retaining a recent tail", () => {
    const units = [
      turnUnit({ turn: "cturn_a", id: "oldest", from: 1, to: 10, tokens: 100_000 }),
      turnUnit({ turn: "cturn_b", id: "middle", from: 11, to: 20, tokens: 100_000 }),
      turnUnit({ turn: "cturn_c", id: "recent", from: 21, to: 30, tokens: 100_000 }),
      turnUnit({
        turn: "cturn_d",
        id: "current",
        from: 31,
        to: 40,
        tokens: 100_000,
        status: "OPEN",
      }),
    ];

    const plan = createContextCompactionPlanner().plan({
      history: history(units),
      policy: policy(60_000, 8_000),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).not.toBeNull();
    expect(plan?.selectedUnitIds).toEqual(["oldest", "middle", "recent"]);
    expect(plan?.cut.kind).toBe("TURN_BOUNDARY");
    expect(plan?.sourceRange.conversationTurnId).toBe(conversationTurnId("cturn_a"));
    expect(plan?.sourceRange.firstSequence).toBe(1);
    expect(plan?.sourceRange.lastSequence).toBe(10);
    expect(plan?.sourceCoverageDelta).toHaveLength(3);
  });

  it("keeps folding inside the open turn when there is no closed turn yet", () => {
    const units: ContextHistoryUnit[] = [
      {
        id: "conversation:cturn_only",
        kind: "CONVERSATION_TURN",
        status: "OPEN",
        messages: refs(conversationTurnId("cturn_only"), 1, 60, 1_000),
        tokenEstimate: 60_000,
        atomicGroupId: "cturn_only",
        compactionEligible: false,
      },
      protocolUnit("cturn_only", "tool-protocol:p1", 10, 15_000),
      protocolUnit("cturn_only", "tool-protocol:p2", 20, 15_000),
      protocolUnit("cturn_only", "tool-protocol:p3", 30, 15_000),
    ];

    const plan = createContextCompactionPlanner().plan({
      history: history(units),
      policy: policy(60_000, 8_000, true),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).not.toBeNull();
    expect(plan?.cut.kind).toBe("PROTOCOL_SAFE_SPLIT");
    expect(plan?.sourceRange.conversationTurnId).toBe(conversationTurnId("cturn_only"));
  });

  it("refuses to fold an open turn that has no safe protocol prefix", () => {
    const units: ContextHistoryUnit[] = [
      {
        id: "conversation:cturn_fresh",
        kind: "CONVERSATION_TURN",
        status: "OPEN",
        messages: refs(conversationTurnId("cturn_fresh"), 1, 6, 1_000),
        tokenEstimate: 6_000,
        atomicGroupId: "cturn_fresh",
        compactionEligible: false,
      },
      protocolUnit("cturn_fresh", "tool-protocol:only", 2, 1_000),
    ];

    const plan = createContextCompactionPlanner().plan({
      history: history(units),
      policy: policy(60_000, 8_000, true),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).toBeNull();
  });

  it("does not fold past the minimum recent tail", () => {
    const units = [
      turnUnit({ turn: "cturn_a", id: "oldest", from: 1, to: 10, tokens: 100_000 }),
      turnUnit({ turn: "cturn_b", id: "middle", from: 11, to: 20, tokens: 100_000 }),
      turnUnit({
        turn: "cturn_c",
        id: "current",
        from: 21,
        to: 30,
        tokens: 100_000,
        status: "OPEN",
      }),
    ];

    const plan = createContextCompactionPlanner().plan({
      history: history(units),
      policy: policy(60_000, 250_000),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).toBeNull();
  });
});

function weightedTurnUnit(input: {
  readonly run: ReturnType<typeof createRunId>;
  readonly turn: string;
  readonly id: string;
  readonly count: number;
  readonly tokens: number;
  readonly status?: "OPEN" | "CLOSED";
}): ContextHistoryUnit {
  const conversationTurn = conversationTurnId(input.turn);
  const status = input.status ?? "CLOSED";
  const baseTokens = Math.floor(input.tokens / input.count);
  const remainder = input.tokens % input.count;
  const messages: ContextMessageRef[] = Array.from({ length: input.count }, (_, index) => ({
    messageId: agentMessageId(`amsg_${input.id}_${String(index + 1).padStart(3, "0")}`),
    runId: input.run,
    conversationTurnId: conversationTurn,
    sequence: index + 1,
    tokenEstimate: baseTokens + (index < remainder ? 1 : 0),
  }));
  return {
    id: input.id,
    kind: "CONVERSATION_TURN",
    status,
    messages,
    tokenEstimate: input.tokens,
    atomicGroupId: input.turn,
    compactionEligible: status === "CLOSED",
  };
}
