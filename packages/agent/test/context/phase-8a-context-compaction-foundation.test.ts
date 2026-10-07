import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import { createRunId, createTimestampMs } from "@caelush/protocol";
import {
  createAgentConversationSnapshot,
  agentMessageId,
  conversationTurnId,
  createContextCompactionPlanner,
  createContextCutPointSelector,
  createContextHistoryIndexer,
  createConversationTurn,
  createContextPressureEvaluator,
  type ContextHistoryIndex,
  type ContextHistoryUnit,
  type ContextPolicy,
  type ContextPressureInput,
  type ContextPressureEvaluation,
} from "@caelush/agent";

import {
  SESSION_ID,
  assistantMessage,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "../messages/fixtures.js";

const THRESHOLDS = {
  effectiveInputLimitTokens: 1_000,
  proactiveCompactionTokens: 750,
  emergencyCompactionTokens: 900,
  targetRecentTailTokens: 350,
  minRecentTailTokens: 150,
} as const;

function pressureInput(overrides: Partial<ContextPressureInput> = {}): ContextPressureInput {
  return {
    estimatedInputTokens: 100,
    mandatoryTokens: 100,
    mode: "NORMAL",
    hasCompressibleHistory: true,
    ...THRESHOLDS,
    ...overrides,
  };
}

function evaluate(overrides: Partial<ContextPressureInput> = {}): ContextPressureEvaluation {
  return createContextPressureEvaluator().evaluate(pressureInput(overrides));
}

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-8a" },
  api: "test-api",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 128 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const runIds = new Map<string, ReturnType<typeof createRunId>>();

function runIdFor(name: string): ReturnType<typeof createRunId> {
  const existing = runIds.get(name);
  if (existing !== undefined) return existing;
  const created = createRunId();
  runIds.set(name, created);
  return created;
}

function closedTurn(name: string, openedAt: number, firstSequence: number, text: string) {
  const runId = runIdFor(name);
  const id = turnIdFor(runId);
  return createConversationTurn({
    id,
    sessionId: SESSION_ID as never,
    runId,
    status: "CLOSED",
    openedAt: createTimestampMs(openedAt),
    closedAt: createTimestampMs(openedAt + 1),
    messages: [
      userMessage({ runId, turnId: id, sequence: firstSequence, text: `${text} user` }),
      assistantMessage({
        runId,
        turnId: id,
        sequence: firstSequence + 1,
        text: `${text} assistant`,
      }),
    ],
  });
}

function openToolTurn(name: string, openedAt: number, firstSequence: number) {
  const runId = runIdFor(name);
  const id = turnIdFor(runId);
  return createConversationTurn({
    id,
    sessionId: SESSION_ID as never,
    runId,
    status: "OPEN",
    openedAt: createTimestampMs(openedAt),
    messages: [
      userMessage({ runId, turnId: id, sequence: firstSequence, text: `${name} user` }),
      assistantMessage({
        runId,
        turnId: id,
        sequence: firstSequence + 1,
        toolCalls: [`${name}_call`],
      }),
    ],
  });
}

function protocolTurn(name: string, openedAt: number, firstSequence: number) {
  const runId = runIdFor(name);
  const id = turnIdFor(runId);
  const messages = [
    userMessage({ runId, turnId: id, sequence: firstSequence, text: `${name} original intent` }),
    assistantMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 1,
      toolCalls: [`${name}_a`],
    }),
    toolResultMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 2,
      toolCallId: `${name}_a`,
      projectedContent: `${name} result A`,
    }),
    assistantMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 3,
      toolCalls: [`${name}_b`],
    }),
    toolResultMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 4,
      toolCallId: `${name}_b`,
      projectedContent: `${name} result B`,
    }),
    assistantMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 5,
      toolCalls: [`${name}_c`],
    }),
    toolResultMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 6,
      toolCallId: `${name}_c`,
      projectedContent: `${name} result C`,
    }),
    assistantMessage({
      runId,
      turnId: id,
      sequence: firstSequence + 7,
      text: `${name} trailing assistant context`,
    }),
  ];
  return createConversationTurn({
    id,
    sessionId: SESSION_ID as never,
    runId,
    status: "CLOSED",
    openedAt: createTimestampMs(openedAt),
    closedAt: createTimestampMs(openedAt + 1),
    messages,
  });
}

function multiToolOpenTurn(name: string, openedAt: number, firstSequence: number) {
  const runId = runIdFor(name);
  const id = turnIdFor(runId);
  return createConversationTurn({
    id,
    sessionId: SESSION_ID as never,
    runId,
    status: "OPEN",
    openedAt: createTimestampMs(openedAt),
    messages: [
      userMessage({ runId, turnId: id, sequence: firstSequence, text: `${name} user` }),
      assistantMessage({
        runId,
        turnId: id,
        sequence: firstSequence + 1,
        toolCalls: [`${name}_a`, `${name}_b`],
      }),
    ],
  });
}

function indexTurns(turns: readonly ReturnType<typeof closedTurn>[]) {
  const current = turns.at(-1);
  if (current === undefined) throw new Error("test history must contain a current turn");
  const conversation = createAgentConversationSnapshot({
    sessionId: SESSION_ID as never,
    currentRunId: current.runId,
    currentTurnId: current.id,
    turns,
  });
  return createContextHistoryIndexer().index({ conversation, model: MODEL });
}

function select(
  history: ContextHistoryIndex,
  targetRecentTailTokens: number,
  minRecentTailTokens: number,
) {
  return createContextCutPointSelector().select({
    history,
    targetRecentTailTokens,
    minRecentTailTokens,
  });
}

function manualTurnUnit(
  id: string,
  turnName: string,
  firstSequence: number,
  lastSequence: number,
  tokenEstimate: number,
): ContextHistoryUnit {
  const turn = conversationTurnId(`cturn_phase_8a_manual_${turnName}`);
  return {
    id,
    kind: "CONVERSATION_TURN",
    status: "CLOSED",
    messages: Array.from({ length: lastSequence - firstSequence + 1 }, (_, offset) => ({
      messageId: agentMessageId(`amsg_phase_8a_${turnName}_${String(firstSequence + offset)}`),
      runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
      conversationTurnId: turn,
      sequence: firstSequence + offset,
      tokenEstimate: tokenEstimate / (lastSequence - firstSequence + 1),
    })),
    tokenEstimate,
    atomicGroupId: id,
    compactionEligible: true,
  };
}

describe("Phase 8A pressure evaluator", () => {
  it("reports NORMAL below the proactive threshold", () => {
    expect(evaluate({ estimatedInputTokens: 749 })).toMatchObject({
      state: "NORMAL",
      trigger: "NONE",
      shouldCompact: false,
      pressureRatio: 0.749,
    });
  });

  it.each([
    [750, "PROACTIVE"],
    [899, "PROACTIVE"],
  ] as const)("reports %s as %s", (estimatedInputTokens, state) => {
    expect(evaluate({ estimatedInputTokens })).toMatchObject({
      state,
      trigger: "PROACTIVE_PRESSURE",
      shouldCompact: true,
    });
  });

  it.each([900, 901] as const)("reports %s as EMERGENCY", (estimatedInputTokens) => {
    expect(evaluate({ estimatedInputTokens })).toMatchObject({
      state: "EMERGENCY",
      trigger: "EMERGENCY_PRESSURE",
      shouldCompact: true,
    });
  });

  it("suppresses compaction when no compressible history exists", () => {
    expect(evaluate({ estimatedInputTokens: 900, hasCompressibleHistory: false })).toMatchObject({
      state: "EMERGENCY",
      trigger: "EMERGENCY_PRESSURE",
      shouldCompact: false,
    });
  });

  it("uses the forced overflow trigger only when forced recovery has history", () => {
    expect(evaluate({ mode: "FORCED_RECOVERY", estimatedInputTokens: 100 })).toMatchObject({
      state: "NORMAL",
      trigger: "FORCED_PROVIDER_OVERFLOW",
      shouldCompact: true,
    });
    expect(
      evaluate({
        mode: "FORCED_RECOVERY",
        estimatedInputTokens: 100,
        hasCompressibleHistory: false,
      }),
    ).toMatchObject({
      trigger: "FORCED_PROVIDER_OVERFLOW",
      shouldCompact: false,
    });
  });

  it("reports mandatory selection pressure when protected input is over budget", () => {
    expect(
      evaluate({
        estimatedInputTokens: 800,
        mandatoryTokens: 1_001,
      }),
    ).toMatchObject({
      state: "PROACTIVE",
      trigger: "SELECTION_PRESSURE",
      shouldCompact: true,
    });
  });

  it("computes the post-compaction hysteresis target without changing the tail target", () => {
    expect(
      evaluate({
        proactiveCompactionTokens: 751,
        targetRecentTailTokens: 333,
        minRecentTailTokens: 111,
      }),
    ).toMatchObject({
      targetPostCompactionTokens: 600,
      targetRecentTailTokens: 333,
      minRecentTailTokens: 111,
    });
  });

  it("rejects invalid effective budgets and unordered thresholds", () => {
    expect(() => evaluate({ effectiveInputLimitTokens: 0 })).toThrow(RangeError);
    expect(() =>
      evaluate({
        proactiveCompactionTokens: 900,
        emergencyCompactionTokens: 750,
      }),
    ).toThrow(RangeError);
  });
});

describe("Phase 8A deterministic safe cut selector", () => {
  it("compacts multiple turns and retains the newest tail", () => {
    const turns = [
      closedTurn("multi_1", 1, 1, "turn one"),
      closedTurn("multi_2", 2, 3, "turn two"),
      closedTurn("multi_3", 3, 5, "turn three"),
      closedTurn("multi_4", 4, 7, "turn four"),
      closedTurn("multi_5", 5, 9, "turn five current"),
    ];
    const history = indexTurns(turns);
    const primary = history.units.filter((unit) => unit.kind === "CONVERSATION_TURN");
    const target =
      primary[2]!.tokenEstimate + primary[3]!.tokenEstimate + primary[4]!.tokenEstimate;

    const candidate = select(history, target, target - 1);

    expect(candidate).not.toBeNull();
    expect(candidate?.cut.kind).toBe("TURN_BOUNDARY");
    expect(candidate?.compactedUnitIds).toEqual(primary.slice(0, 2).map((unit) => unit.id));
    expect(candidate?.retainedUnitIds).toEqual(primary.slice(2).map((unit) => unit.id));
    expect(candidate?.retainedTokens).toBe(target);
    expect(candidate?.cut).toMatchObject({
      firstKeptTurnId: primary[2]!.messages[0]!.conversationTurnId,
      firstKeptMessageId: primary[2]!.messages[0]!.messageId,
      firstKeptSequence: primary[2]!.messages[0]!.sequence,
    });
    expect(candidate?.retainedUnitIds).toContain(primary.at(-1)!.id);
  });

  it("prefers a full Turn boundary over a legal protocol split", () => {
    const turns = [
      protocolTurn("preferred_old", 1, 1),
      closedTurn("preferred_current", 2, 20, "current"),
    ];
    const history = indexTurns(turns);
    const current = history.units.find(
      (unit) => unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.sequence === 20,
    )!;

    const candidate = select(history, current.tokenEstimate, current.tokenEstimate);

    expect(candidate?.cut.kind).toBe("TURN_BOUNDARY");
    expect(candidate?.compactedUnitIds).toEqual([`conversation:${turns[0]!.id}`]);
  });

  it("protects an OPEN protocol and the current Turn", () => {
    const turns = [
      closedTurn("open_protected_old", 1, 1, "old"),
      openToolTurn("open_protected_current", 2, 3),
    ];
    const history = indexTurns(turns);
    const current = history.units.find(
      (unit) =>
        unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.conversationTurnId === turns[1]!.id,
    )!;

    const candidate = select(history, current.tokenEstimate, current.tokenEstimate);

    expect(candidate?.cut.kind).toBe("TURN_BOUNDARY");
    expect(candidate?.compactedUnitIds).toEqual([`conversation:${turns[0]!.id}`]);
    expect(candidate?.retainedUnitIds).toContain(`conversation:${turns[1]!.id}`);
    expect(history.openUnits.some((unit) => candidate?.compactedUnitIds.includes(unit.id))).toBe(
      false,
    );
  });

  it("keeps a CLOSED Tool protocol atomic", () => {
    const turns = [
      protocolTurn("atomic_old", 1, 1),
      closedTurn("atomic_current", 2, 20, "current"),
    ];
    const history = indexTurns(turns);
    const current = history.units.find(
      (unit) =>
        unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.conversationTurnId === turns[1]!.id,
    )!;
    const oldProtocols = history.units.filter(
      (unit) =>
        unit.kind === "TOOL_PROTOCOL" && unit.messages[0]?.conversationTurnId === turns[0]!.id,
    );

    const candidate = select(history, current.tokenEstimate, current.tokenEstimate);

    expect(candidate?.cut.kind).toBe("TURN_BOUNDARY");
    expect(candidate?.compactedUnitIds).toEqual([`conversation:${turns[0]!.id}`]);
    expect(candidate?.compactedUnitIds).not.toContain(oldProtocols[0]!.id);
  });

  it("splits only between CLOSED protocols inside a huge historical Turn", () => {
    const turns = [
      protocolTurn("huge_historical", 1, 1),
      closedTurn("huge_current", 2, 20, "current"),
    ];
    const history = indexTurns(turns);
    const oldTurn = history.units.find(
      (unit) =>
        unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.conversationTurnId === turns[0]!.id,
    )!;
    const current = history.units.find(
      (unit) =>
        unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.conversationTurnId === turns[1]!.id,
    )!;
    const protocols = history.units.filter(
      (unit) =>
        unit.kind === "TOOL_PROTOCOL" && unit.messages[0]?.conversationTurnId === turns[0]!.id,
    );
    const keptAfterProtocolB = oldTurn.messages.filter(
      (message) => message.sequence >= protocols[2]!.messages[0]!.sequence,
    );
    const retainedTarget = keptAfterProtocolB.reduce(
      (total, message) => total + (message.tokenEstimate ?? 0),
      current.tokenEstimate,
    );

    const candidate = select(history, retainedTarget, retainedTarget);

    expect(candidate?.cut.kind).toBe("PROTOCOL_SAFE_SPLIT");
    expect(candidate?.cut).toMatchObject({
      conversationTurnId: turns[0]!.id,
      originalUserMessageId: oldTurn.messages[0]!.messageId,
      firstKeptProtocolUnitId: protocols[2]!.id,
      firstKeptMessageId: protocols[2]!.messages[0]!.messageId,
      firstKeptSequence: protocols[2]!.messages[0]!.sequence,
    });
    expect(candidate?.retainedTokens).toBe(retainedTarget);
    expect(candidate?.compactedUnitIds).toContain(protocols[0]!.id);
    expect(candidate?.compactedUnitIds).toContain(protocols[1]!.id);
  });

  it("does not split a multi-tool Assistant protocol", () => {
    const turns = [
      multiToolOpenTurn("multi_tool_open", 1, 1),
      closedTurn("multi_tool_current", 2, 3, "current"),
    ];
    const history = indexTurns(turns);
    const current = history.units.find(
      (unit) =>
        unit.kind === "CONVERSATION_TURN" && unit.messages[0]?.conversationTurnId === turns[1]!.id,
    )!;

    const candidate = select(history, current.tokenEstimate, current.tokenEstimate);

    expect(candidate).toBeNull();
  });

  it("preserves the configured minimum recent tail", () => {
    const turns = [
      closedTurn("minimum_one", 1, 1, "one"),
      closedTurn("minimum_two", 2, 3, "two"),
      closedTurn("minimum_current", 3, 5, "current"),
    ];
    const history = indexTurns(turns);
    const primary = history.units.filter((unit) => unit.kind === "CONVERSATION_TURN");
    const minimum = primary[1]!.tokenEstimate + primary[2]!.tokenEstimate;

    const candidate = select(history, 1, minimum);

    expect(candidate).not.toBeNull();
    expect(candidate?.retainedTokens).toBeGreaterThanOrEqual(minimum);
    expect(candidate?.retainedUnitIds).toEqual(primary.slice(1).map((unit) => unit.id));
  });

  it("keeps Snapshot Turn order when Run-local sequences restart", () => {
    const turns = [
      closedTurn("shuffled_one", 1, 1, "one"),
      closedTurn("shuffled_two", 2, 1, "two"),
      closedTurn("shuffled_current", 3, 1, "current"),
    ];
    const history = indexTurns(turns);
    const primary = history.units.filter((unit) => unit.kind === "CONVERSATION_TURN");

    expect(primary.map((unit) => unit.messages.map((message) => message.sequence))).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(select(history, primary[1]!.tokenEstimate, 0)).not.toBeNull();
  });

  it("produces stable estimates for English, Chinese, emoji, and code text", () => {
    const make = () =>
      indexTurns([
        closedTurn("stable_text", 1, 1, "English 中文 🚀 const x = () => 42;"),
        closedTurn("stable_text_current", 2, 3, "current"),
      ]);
    const first = make();
    const second = make();
    const firstTokens = first.units
      .filter((unit) => unit.kind === "CONVERSATION_TURN")
      .map((unit) => unit.tokenEstimate);
    const secondTokens = second.units
      .filter((unit) => unit.kind === "CONVERSATION_TURN")
      .map((unit) => unit.tokenEstimate);

    expect(secondTokens).toEqual(firstTokens);
    expect(firstTokens.every((tokens) => Number.isSafeInteger(tokens) && tokens > 0)).toBe(true);
  });
});

describe("Phase 8A planner integration", () => {
  it("fails closed when a V2 compaction range would span multiple ConversationTurns", () => {
    const units = [
      manualTurnUnit("turn-a", "a", 1, 2, 40),
      manualTurnUnit("turn-b", "b", 1, 2, 40),
      manualTurnUnit("turn-current", "current", 1, 2, 20),
    ];
    const history: ContextHistoryIndex = {
      units,
      openUnits: [],
      closedUnits: units,
      estimatedTokens: 100,
    };
    const policy = {
      targetRecentTailTokens: 20,
      minRecentTailTokens: 20,
    } as ContextPolicy;

    const plan = createContextCompactionPlanner().plan({
      history,
      policy,
      reason: "SELECTION_PRESSURE",
    });

    expect(plan).toBeNull();
  });
});
