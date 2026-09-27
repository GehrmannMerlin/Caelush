import { describe, expect, it } from "vitest";

import { createRunId } from "@caelush/protocol";
import {
  agentMessageId,
  conversationTurnId,
  createContextCheckpointId,
  createContextCompactionCoverage,
  createContextIncrementalCompactionResolver,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createIncrementalCheckpointResolver,
  type ContextHistoryIndex,
  type ContextHistoryUnit,
  type ContextMessageRef,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type ContextCompactionPlan,
  type IncrementalCheckpointState,
  type LegacyContextCheckpointRecordV1,
  type StoredAgentMessage,
  type ToolProtocolUnit,
} from "@caelush/agent";
import {
  assistantMessage as fixtureAssistant,
  snapshot as fixtureSnapshot,
  turn as fixtureTurn,
  userMessage as fixtureUser,
} from "../messages/fixtures.js";

const RUN_ID = createRunId();
const OTHER_RUN_ID = createRunId();

function messageRef(
  name: string,
  sequence: number,
  turnName: string,
  tokenEstimate: number,
  runId = RUN_ID,
): ContextMessageRef {
  return {
    messageId: agentMessageId(`amsg_phase_8b_${name}`),
    runId,
    conversationTurnId: conversationTurnId(`cturn_phase_8b_${turnName}`),
    sequence,
    tokenEstimate,
  };
}

function turnUnit(
  id: string,
  refs: readonly ContextMessageRef[],
  options: Partial<Pick<ContextHistoryUnit, "status" | "compactionEligible">> = {},
): ContextHistoryUnit {
  return {
    id: `conversation:${id}`,
    kind: "CONVERSATION_TURN",
    status: options.status ?? "CLOSED",
    messages: refs,
    tokenEstimate: refs.reduce((total, ref) => total + (ref.tokenEstimate ?? 0), 0),
    atomicGroupId: id,
    compactionEligible: options.compactionEligible ?? true,
  };
}

function protocolUnit(
  id: string,
  refs: readonly ContextMessageRef[],
  sourceAssistantMessageId: ContextMessageRef,
): ToolProtocolUnit {
  return {
    id: `tool-protocol:${id}`,
    kind: "TOOL_PROTOCOL",
    status: "CLOSED",
    messages: refs,
    tokenEstimate: refs.reduce((total, ref) => total + (ref.tokenEstimate ?? 0), 0),
    atomicGroupId: `tool-protocol:${id}`,
    compactionEligible: true,
    sourceAssistantMessageId: sourceAssistantMessageId.messageId,
    toolCallIds: [`call_${id}`],
    toolResultMessageIds: [refs.at(-1)!.messageId],
  };
}

function history(units: readonly ContextHistoryUnit[]): ContextHistoryIndex {
  const unique = new Map<string, number>();
  for (const unit of units) {
    for (const ref of unit.messages) unique.set(String(ref.messageId), ref.tokenEstimate ?? 0);
  }
  return {
    units,
    openUnits: units.filter((unit) => unit.status === "OPEN"),
    closedUnits: units.filter((unit) => unit.status === "CLOSED"),
    estimatedTokens: [...unique.values()].reduce((total, tokens) => total + tokens, 0),
  };
}

function checkpoint(
  first: ContextMessageRef,
  last: ContextMessageRef,
  overrides: Partial<Pick<ContextCheckpointRecordV2, "checkpointId" | "previousCheckpointId">> = {},
): ContextCheckpointRecordV2 {
  const sourceRange = createContextMessageRange({
    runId: first.runId,
    conversationTurnId: first.conversationTurnId,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
  });
  return {
    checkpointId: overrides.checkpointId ?? createContextCheckpointId("checkpoint_8b_v2"),
    runId: first.runId,
    schemaVersion: 2,
    ...(overrides.previousCheckpointId === undefined
      ? {}
      : { previousCheckpointId: overrides.previousCheckpointId }),
    sourceRange,
    structuredCheckpoint: {
      version: 1,
      goal: "goal",
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "UNKNOWN",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "UNKNOWN",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: first.sequence, to: last.sequence },
    },
    tokensBefore: 100,
    tokensAfter: 20,
    modelRef: { provider: "test", model: "phase-8b" },
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "source",
    checkpointDigest: "checkpoint",
    degraded: false,
    reason: "SELECTION_PRESSURE",
    createdAt: 1 as never,
  };
}

function legacyCheckpoint(first: number, last: number): LegacyContextCheckpointRecordV1 {
  return {
    checkpointId: "checkpoint_8b_v1",
    runId: String(RUN_ID),
    schemaVersion: 1,
    sourceSequenceFrom: first,
    sourceSequenceTo: last,
    structuredCheckpoint: {
      version: 1,
      goal: "legacy goal",
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "UNKNOWN",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "UNKNOWN",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: first, to: last },
    },
    tokensBefore: 100,
    tokensAfter: 20,
    modelRef: { providerId: "test", modelId: "phase-8b" },
    createdAt: 1,
  };
}

function expectInconsistentPlan(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected ContextPlanningError(INCONSISTENT_PLAN).");
  } catch (error) {
    expect(error).toMatchObject({ code: "INCONSISTENT_PLAN" });
  }
}

function storedRef(stored: StoredAgentMessage): ContextMessageRef {
  return {
    messageId: stored.message.id,
    runId: stored.message.runId,
    conversationTurnId: stored.message.conversationTurnId,
    sequence: stored.sequence,
    tokenEstimate: 1,
  };
}

function planForRange(
  sourceRange: ReturnType<typeof createContextMessageRange>,
): ContextCompactionPlan {
  return {
    reason: "SELECTION_PRESSURE",
    cut: {
      kind: "TURN_BOUNDARY",
      firstKeptTurnId: sourceRange.conversationTurnId,
      firstKeptMessageId: sourceRange.lastMessageId,
      firstKeptSequence: sourceRange.lastSequence + 1,
    },
    sourceRange,
    selectedUnitIds: ["conversation:phase-8b"],
    retainedUnitIds: [],
    estimatedTokensBefore: 100,
    selectedTokens: 60,
    retainedTokens: 40,
    targetRecentTailTokens: 40,
    minRecentTailTokens: 20,
  };
}

function historyFromStored(messages: readonly StoredAgentMessage[]): ContextHistoryIndex {
  const refs = messages.map(storedRef);
  const unit: ContextHistoryUnit = {
    id: "conversation:phase-8b",
    kind: "CONVERSATION_TURN",
    status: "CLOSED",
    messages: refs,
    tokenEstimate: refs.length,
    atomicGroupId: "phase-8b",
    compactionEligible: true,
  };
  return history([unit]);
}

function repositoryWithLatest(
  latest: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined,
): ContextCheckpointRepositoryPort {
  const v2 = latest?.schemaVersion === 2 ? latest : undefined;
  return {
    async create() {
      if (v2 === undefined) throw new Error("fixture create is not used");
      return v2;
    },
    async getLatestByRun() {
      return latest;
    },
    async getById() {
      return latest;
    },
    async listByRun() {
      return latest === undefined ? [] : [latest];
    },
  };
}

describe("Phase 8B canonical Context checkpoint coverage", () => {
  it("removes a cross-Turn V2 range and counts overlapping refs once", () => {
    const turnARefs = [messageRef("a_1", 1, "a", 10), messageRef("a_2", 2, "a", 10)];
    const turnBRefs = [messageRef("b_1", 3, "b", 20), messageRef("b_2", 4, "b", 20)];
    const turnCRefs = [messageRef("c_1", 5, "c", 30), messageRef("c_2", 6, "c", 30)];
    const indexed = history([
      turnUnit("a", turnARefs),
      turnUnit("b", turnBRefs),
      turnUnit("c", turnCRefs),
      protocolUnit("b", [turnBRefs[0]!, turnBRefs[1]!], turnBRefs[0]!),
    ]);

    const projection = createContextCompactionCoverage({
      history: indexed,
      latestCheckpoint: checkpoint(turnARefs[0]!, turnBRefs[1]!),
    });

    expect(projection.history.units.map((unit) => unit.id)).toEqual(["conversation:c"]);
    expect(projection.history.estimatedTokens).toBe(60);
    expect([...projection.coveredMessageIds]).toEqual(
      ["a_1", "a_2", "b_1", "b_2"].map((name) => `amsg_phase_8b_${name}`),
    );
  });

  it("keeps only the residual messages after a protocol-safe partial Turn cut", () => {
    const refs = Array.from({ length: 9 }, (_, index) =>
      messageRef(`huge_${index + 1}`, index + 1, "huge", index + 1),
    );
    const indexed = history([
      turnUnit("huge", refs),
      protocolUnit("a", [refs[1]!, refs[2]!], refs[1]!),
      protocolUnit("b", [refs[3]!, refs[4]!], refs[3]!),
      protocolUnit("c", [refs[5]!, refs[6]!], refs[5]!),
      protocolUnit("d", [refs[7]!, refs[8]!], refs[7]!),
    ]);

    const projection = createContextCompactionCoverage({
      history: indexed,
      latestCheckpoint: checkpoint(refs[0]!, refs[4]!),
    });

    const residualTurn = projection.history.units.find((unit) => unit.id === "conversation:huge");
    expect(residualTurn?.messages.map((ref) => ref.sequence)).toEqual([6, 7, 8, 9]);
    expect(residualTurn?.tokenEstimate).toBe(30);
    expect(projection.history.estimatedTokens).toBe(30);
  });

  it("fails closed when a V2 range bisects a ToolProtocolUnit", () => {
    const refs = [messageRef("call", 1, "protocol", 10), messageRef("result", 2, "protocol", 10)];
    const indexed = history([turnUnit("protocol", refs), protocolUnit("protocol", refs, refs[0]!)]);

    expectInconsistentPlan(() =>
      createContextCompactionCoverage({
        history: indexed,
        latestCheckpoint: checkpoint(refs[0]!, refs[0]!),
      }),
    );
  });

  it("retains a complete affected protocol when a legacy V1 cutoff is partial", () => {
    const refs = [
      messageRef("legacy_user", 1, "legacy", 10),
      messageRef("legacy_call", 2, "legacy", 20),
      messageRef("legacy_result", 3, "legacy", 30),
    ];
    const indexed = history([
      turnUnit("legacy", refs),
      protocolUnit("legacy", refs.slice(1), refs[1]!),
    ]);

    const projection = createContextCompactionCoverage({
      history: indexed,
      latestCheckpoint: legacyCheckpoint(1, 2),
    });

    expect(projection.history.estimatedTokens).toBe(50);
    expect(projection.history.units[0]?.messages.map((ref) => ref.sequence)).toEqual([2, 3]);
    expect([...projection.coveredMessageIds]).toEqual(["amsg_phase_8b_legacy_user"]);
    expect(projection.trustedPreviousCheckpointId).toBeUndefined();
    expect(projection.previousCheckpoint?.goal).toBe("legacy goal");
  });

  it("rejects mismatched range identity and mixed Run coverage", () => {
    const first = messageRef("identity_first", 1, "identity", 10);
    const middle = messageRef("identity_middle", 2, "identity", 10, OTHER_RUN_ID);
    const last = messageRef("identity_last", 3, "identity", 10);
    const indexed = history([turnUnit("identity", [first, middle, last])]);

    expectInconsistentPlan(() =>
      createContextCompactionCoverage({
        history: indexed,
        latestCheckpoint: checkpoint(first, last),
      }),
    );

    expectInconsistentPlan(() =>
      createContextCompactionCoverage({
        history: history([turnUnit("identity", [first, last])]),
        latestCheckpoint: checkpoint(first, messageRef("not_in_history", 3, "identity", 10)),
      }),
    );
  });
});

describe("Phase 8B incremental checkpoint and source resolution", () => {
  const messages = [
    fixtureUser({ runId: String(RUN_ID), sequence: 1, text: "A first" }),
    fixtureAssistant({ runId: String(RUN_ID), sequence: 100, text: "A last" }),
    fixtureUser({ runId: String(RUN_ID), sequence: 101, text: "B first" }),
    fixtureUser({ runId: String(RUN_ID), sequence: 150, text: "hidden B", modelVisible: false }),
    fixtureAssistant({ runId: String(RUN_ID), sequence: 160, text: "B last" }),
    fixtureUser({ runId: String(RUN_ID), sequence: 161, text: "C first" }),
    fixtureAssistant({ runId: String(RUN_ID), sequence: 220, text: "C last" }),
  ];
  const refs = messages.map(storedRef);
  const rangeA = createContextMessageRange({
    runId: RUN_ID,
    conversationTurnId: refs[0]!.conversationTurnId,
    firstMessageId: refs[0]!.messageId,
    lastMessageId: refs[1]!.messageId,
    firstSequence: 1,
    lastSequence: 100,
  });
  const rangeB = createContextMessageRange({
    runId: RUN_ID,
    conversationTurnId: refs[2]!.conversationTurnId,
    firstMessageId: refs[2]!.messageId,
    lastMessageId: refs[4]!.messageId,
    firstSequence: 101,
    lastSequence: 160,
  });
  const rangeC = createContextMessageRange({
    runId: RUN_ID,
    conversationTurnId: refs[5]!.conversationTurnId,
    firstMessageId: refs[5]!.messageId,
    lastMessageId: refs[6]!.messageId,
    firstSequence: 161,
    lastSequence: 220,
  });
  const conversation = fixtureSnapshot([
    fixtureTurn(messages, { runId: String(RUN_ID), status: "CLOSED", openedAt: 1 }),
  ]);

  it("resolves NONE, V2, and legacy state without inventing a predecessor", async () => {
    const historyIndex = historyFromStored(messages);
    const none = await createIncrementalCheckpointResolver({
      checkpointRepository: repositoryWithLatest(undefined),
    }).resolve({ runId: RUN_ID, history: historyIndex });
    expect(none).toEqual({ kind: "NONE" });

    const checkpointA = checkpoint(refs[0]!, refs[1]!);
    const v2 = await createIncrementalCheckpointResolver({
      checkpointRepository: repositoryWithLatest(checkpointA),
    }).resolve({ runId: RUN_ID, history: historyIndex });
    expect(v2).toEqual({ kind: "V2", checkpoint: checkpointA });

    const legacy = await createIncrementalCheckpointResolver({
      checkpointRepository: repositoryWithLatest(legacyCheckpoint(1, 100)),
    }).resolve({ runId: RUN_ID, history: historyIndex });
    expect(legacy).toMatchObject({ kind: "LEGACY_V1" });
    expect(
      (legacy as Extract<IncrementalCheckpointState, { kind: "LEGACY_V1" }>).checkpoint
        .schemaVersion,
    ).toBe(1);
  });

  it("builds cumulative A-to-B-to-C ranges from only the new model-visible source", () => {
    const resolver = createContextIncrementalCompactionResolver();
    const checkpointA = checkpoint(refs[0]!, refs[1]!);
    const checkpointB = checkpoint(refs[0]!, refs[4]!);

    const first = resolver.resolve({
      plan: planForRange(rangeB),
      latest: { kind: "V2", checkpoint: checkpointA },
      conversation,
    });
    expect(first).toMatchObject({
      previousCheckpoint: checkpointA,
      newSourceRange: rangeB,
      cumulativeSourceRange: {
        firstMessageId: rangeA.firstMessageId,
        firstSequence: 1,
        lastMessageId: rangeB.lastMessageId,
        lastSequence: 160,
      },
    });
    expect(first.newSourceMessages.map((message) => message.sequence)).toEqual([101, 160]);

    const second = resolver.resolve({
      plan: planForRange(rangeC),
      latest: { kind: "V2", checkpoint: checkpointB },
      conversation,
    });
    expect(second.cumulativeSourceRange).toMatchObject({
      firstMessageId: rangeA.firstMessageId,
      firstSequence: 1,
      lastMessageId: rangeC.lastMessageId,
      lastSequence: 220,
    });
    expect(second.newSourceMessages.map((message) => message.sequence)).toEqual([161, 220]);

    const none = resolver.resolve({
      plan: planForRange(rangeB),
      latest: { kind: "NONE" },
      conversation,
    });
    expect(none.previousCheckpoint).toBeUndefined();
    expect(none.cumulativeSourceRange).toEqual(rangeB);

    const legacy = resolver.resolve({
      plan: planForRange(rangeB),
      latest: { kind: "LEGACY_V1", checkpoint: legacyCheckpoint(1, 100) },
      conversation,
    });
    expect(legacy.previousCheckpoint).toBeUndefined();
    expect(legacy.cumulativeSourceRange).toEqual(rangeB);
  });

  it("fails closed for invalid V2 coverage, overlap, and endpoint identity", async () => {
    const invalidCheckpoint = checkpoint(refs[0]!, refs[1]!);
    const badRepository = repositoryWithLatest({
      ...invalidCheckpoint,
      sourceRange: createContextMessageRange({
        ...invalidCheckpoint.sourceRange,
        lastMessageId: agentMessageId("amsg_missing_endpoint"),
        lastSequence: 100,
      }),
    });
    await expect(
      createIncrementalCheckpointResolver({ checkpointRepository: badRepository }).resolve({
        runId: RUN_ID,
        history: historyFromStored(messages),
      }),
    ).rejects.toMatchObject({ code: "INCONSISTENT_PLAN" });

    const resolver = createContextIncrementalCompactionResolver();
    expect(() =>
      resolver.resolve({
        plan: planForRange(rangeB),
        latest: { kind: "V2", checkpoint: invalidCheckpoint },
        conversation,
      }),
    ).not.toThrow();
    expect(() =>
      resolver.resolve({
        plan: planForRange(
          createContextMessageRange({
            ...rangeB,
            firstMessageId: refs[1]!.messageId,
            firstSequence: 100,
          }),
        ),
        latest: { kind: "V2", checkpoint: invalidCheckpoint },
        conversation,
      }),
    ).toThrowError(/inconsistent/i);
    expect(() =>
      resolver.resolve({
        plan: planForRange(
          createContextMessageRange({
            ...rangeB,
            firstMessageId: agentMessageId("amsg_missing_endpoint"),
          }),
        ),
        latest: { kind: "NONE" },
        conversation,
      }),
    ).toThrowError(/inconsistent/i);
  });
});
