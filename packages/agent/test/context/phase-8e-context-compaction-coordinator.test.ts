import { describe, expect, it } from "vitest";

import {
  createContextCompactionCoordinator,
  createContextCheckpointEnricher,
  createContextMessageRange,
  createStructuredCheckpoint,
  createHistorySourceRef,
  createDeterministicCheckpointBuilder,
  agentMessageId,
  conversationTurnId,
  type ContextCompactionDependencies,
  type ContextCompactionPlan,
  type ContextCompactionRequest,
  type ContextCheckpointIdFactory,
  type ContextSummarizationInput,
  type ContextSummarizationResult,
} from "@caelush/agent";
import { ContextSummarizationInfrastructureError } from "@caelush/agent";
import {
  assistantMessage,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "../messages/fixtures.js";

const request = {
  identity: {
    runId: "run_phase_8e" as never,
    sessionId: "session_phase_8e" as never,
    goal: "goal",
  },
  conversation: {} as never,
  history: { units: [], openUnits: [], closedUnits: [], estimatedTokens: 0 },
  policy: {
    effectiveInputLimitTokens: 100,
    outputReserveTokens: 20,
    targetRecentTailTokens: 10,
    minRecentTailTokens: 5,
  } as never,
  model: { ref: { provider: "test", model: "phase-8e" } } as never,
  estimatedInputTokensBefore: 80,
  fixedInputTokens: 20,
  boundaryTokens: 4,
  reason: "PROACTIVE_PRESSURE",
  signal: new AbortController().signal,
} satisfies ContextCompactionRequest;

const range = createContextMessageRange({
  runId: "run_phase_8e" as never,
  conversationTurnId: "turn_phase_8e" as never,
  firstMessageId: "message_phase_8e_first" as never,
  lastMessageId: "message_phase_8e_last" as never,
  firstSequence: 1,
  lastSequence: 2,
});

const plan = {
  reason: "PROACTIVE_PRESSURE",
  cut: {
    kind: "TURN_BOUNDARY",
    firstKeptTurnId: conversationTurnId("turn_kept"),
    firstKeptMessageId: agentMessageId("message_kept"),
    firstKeptSequence: 3,
  },
  sourceRange: range,
  selectedUnitIds: ["unit_selected"],
  retainedUnitIds: ["unit_retained"],
  estimatedTokensBefore: 80,
  selectedTokens: 60,
  retainedTokens: 20,
  targetRecentTailTokens: 10,
  minRecentTailTokens: 5,
} satisfies ContextCompactionPlan;

const structuredCheckpoint = createStructuredCheckpoint({
  version: 1,
  goal: "goal",
  constraints: [],
  completedWork: ["done"],
  inProgress: [],
  blocked: [],
  importantDiscoveries: [],
  keyDecisions: [],
  changedFiles: [],
  readFiles: [],
  recentErrors: [],
  verificationState: "CURRENT",
  activeProcesses: [],
  pendingApprovals: [],
  resourceGovernance: "BOUNDED",
  criticalReferences: [],
  nextIntent: "continue",
  sourceRange: { from: 1, to: 2 },
});

const summary: ContextSummarizationResult = {
  semantic: {
    constraints: [],
    completedWork: ["done"],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    criticalReferences: [],
    nextIntent: "continue",
  },
  modelRef: { provider: "test", model: "phase-8e" },
  finishReason: "STOP",
  summaryPromptVersion: 4,
  sourceDigest: "semantic-source",
  semanticDigest: "semantic",
};

function dependencies(
  planner: ContextCompactionDependencies["planner"],
  overrides: Partial<ContextCompactionDependencies> = {},
): ContextCompactionDependencies {
  const checkpointIdFactory: ContextCheckpointIdFactory = { create: () => "ctx_phase_8e" as never };
  return {
    planner,
    incrementalResolver: {
      resolve: () => ({
        newSourceMessages: [],
        cumulativeSourceRange: range,
        newSourceRange: range,
      }),
    },
    checkpointBudget: { resolve: () => ({ targetTokens: 5, maxTokens: 8_192 }) },
    gainEvaluator: {
      evaluate: () => ({
        selectedTokens: 60,
        estimatedCheckpointTokens: 8,
        estimatedFreedTokens: 52,
        gainRatio: 0.86,
      }),
    },
    summarizer: { summarize: async () => summary },
    summaryValidator: { validate: ({ result }) => ({ outcome: "ACCEPTED", result }) },
    factsProvider: {
      collect: async () => ({
        readFiles: [],
        changedFiles: [],
        recentErrors: [],
        verificationState: "CURRENT",
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "BOUNDED",
      }),
    },
    deterministicFallback: { build: () => structuredCheckpoint },
    enricher: { enrich: () => structuredCheckpoint },
    rehydrator: {} as never,
    tentativeRebuilder: {
      rebuild: async () => ({ estimatedInputTokens: 42, retainedMessageIds: [] }),
    },
    commit: {
      commit: async ({ checkpoint, events }) => ({
        checkpoint: { ...checkpoint, schemaVersion: 2 as const },
        events: events as never,
      }),
    },
    clock: { now: () => 1 as never },
    checkpointIdFactory,
    ...overrides,
  };
}

describe("Phase 8E ContextCompactionCoordinator", () => {
  it("reports bounded preparation, summary, and rebuild stages to the live observer", async () => {
    const stages: Array<string> = [];
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies({ plan: () => plan }),
      latest: { kind: "NONE" },
      onProgress: (stage, reason) => stages.push(`${stage}:${reason}`),
    });

    await expect(coordinator.compact(request)).resolves.toMatchObject({ kind: "COMPACTED" });
    expect(stages).toEqual([
      "PREPARING:PROACTIVE_PRESSURE",
      "SUMMARIZING:PROACTIVE_PRESSURE",
      "REBUILDING:PROACTIVE_PRESSURE",
    ]);
  });

  it("maps an absent compaction plan to NO_COMPRESSIBLE_HISTORY", async () => {
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies({ plan: () => null }),
      latest: { kind: "NONE" },
    });

    await expect(coordinator.compact(request)).resolves.toEqual({
      kind: "NOT_APPLICABLE",
      reason: "NO_COMPRESSIBLE_HISTORY",
    });
  });

  it("runs one semantic attempt, rebuilds before commit, and returns the committed receipt", async () => {
    let summaryCalls = 0;
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          summarizer: {
            summarize: async () => {
              summaryCalls += 1;
              return summary;
            },
          },
          enricher: createContextCheckpointEnricher(),
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    const result = await coordinator.compact(request);

    expect(result.kind).toBe("COMPACTED");
    if (result.kind === "COMPACTED") {
      expect(result.checkpoint.tokensAfter).toBe(42);
      expect(result.receipt.tokensAfter).toBe(42);
      expect(result.checkpoint.degraded).toBe(false);
      expect(result.checkpoint.structuredCheckpoint.criticalReferences).toContain(
        createHistorySourceRef({
          runId: range.runId,
          firstSequence: range.firstSequence,
          lastSequence: range.lastSequence,
        }),
      );
    }
    expect(summaryCalls).toBe(1);
    expect(commitCalls).toBe(1);
  });

  it("keeps the legal original history when a proactive summarization fails", async () => {
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          summarizer: {
            summarize: async () => {
              throw new Error("summary provider unavailable");
            },
          },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(
      coordinator.compact({
        ...request,
        reason: "PROACTIVE_PRESSURE",
      }),
    ).resolves.toEqual({
      kind: "KEEP_ORIGINAL",
      reason: "SUMMARY_UNAVAILABLE_ORIGINAL_FITS",
      summaryOutcome: "FAILED",
    });
    expect(commitCalls).toBe(0);
  });

  it("never keeps the original after the provider already rejected it", async () => {
    let committed: import("@caelush/agent").ContextCheckpointRecordV2 | undefined;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          summarizer: {
            summarize: async () => {
              throw new Error("summary provider unavailable");
            },
          },
          deterministicFallback: createDeterministicCheckpointBuilder(),
          commit: {
            commit: async ({ checkpoint, events }) => {
              committed = { ...checkpoint, schemaVersion: 2 as const };
              return { checkpoint: committed, events: events as never };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    // The estimate still says "fits" (80 <= the effective limit), but a forced overflow means the
    // provider already rejected this exact request. Keeping the original here is a guaranteed
    // second rejection, so the degraded checkpoint must land instead.
    const result = await coordinator.compact({
      ...request,
      estimatedInputTokensBefore: 80,
      reason: "FORCED_PROVIDER_OVERFLOW",
    });

    expect(result.kind).toBe("COMPACTED");
    expect(committed?.degraded).toBe(true);
  });

  it("commits a degraded checkpoint with a real source reference after forced overflow", async () => {
    let committed: import("@caelush/agent").ContextCheckpointRecordV2 | undefined;
    const sourceRef = createHistorySourceRef({
      runId: range.runId,
      firstSequence: range.firstSequence,
      lastSequence: range.lastSequence,
    });
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          summarizer: {
            summarize: async () => {
              throw new Error("summary provider unavailable");
            },
          },
          deterministicFallback: createDeterministicCheckpointBuilder(),
          commit: {
            commit: async ({ checkpoint, events }) => {
              committed = { ...checkpoint, schemaVersion: 2 as const };
              return { checkpoint: committed, events: events as never };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    const result = await coordinator.compact({
      ...request,
      estimatedInputTokensBefore: 120,
      reason: "FORCED_PROVIDER_OVERFLOW",
    });

    expect(result.kind).toBe("COMPACTED");
    expect(committed?.degraded).toBe(true);
    expect(committed?.structuredCheckpoint.criticalReferences).toContain(sourceRef);
  });

  it("summarizes oversized history in closed Tool units and carries facts forward", async () => {
    const runId = String(request.identity.runId);
    const sessionId = String(request.identity.sessionId);
    const turnId = turnIdFor(runId);
    const sourceMessages = [
      userMessage({
        runId,
        sessionId,
        turnId,
        sequence: 1,
        text: "Original request ".repeat(180),
      }),
      ...Array.from({ length: 3 }, (_, index) => {
        const callId = `call_segment_${String(index + 1)}`;
        const assistant = assistantMessage({
          runId,
          sessionId,
          turnId,
          sequence: index * 2 + 2,
          toolCalls: [callId],
          text: `complete operation ${String(index + 1)} `.repeat(180),
        });
        const result = toolResultMessage({
          runId,
          sessionId,
          turnId,
          sequence: index * 2 + 3,
          toolCallId: callId,
          projectedContent: `verified result ${String(index + 1)} `.repeat(180),
        });
        return [assistant, result] as const;
      }).flat(),
    ];
    const first = sourceMessages[0]!;
    const last = sourceMessages.at(-1)!;
    const sourceRange = createContextMessageRange({
      runId: first.message.runId,
      conversationTurnId: first.message.conversationTurnId,
      firstMessageId: first.message.id,
      lastMessageId: last.message.id,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
    });
    const protocolUnits = Array.from({ length: 3 }, (_, index) => {
      const assistant = sourceMessages[index * 2 + 1]!;
      const toolResult = sourceMessages[index * 2 + 2]!;
      return {
        id: `tool-protocol:segment-${String(index + 1)}`,
        kind: "TOOL_PROTOCOL" as const,
        status: "CLOSED" as const,
        messages: [assistant, toolResult].map((stored) => ({
          messageId: stored.message.id,
          runId: stored.message.runId,
          conversationTurnId: stored.message.conversationTurnId,
          sequence: stored.sequence,
        })),
        tokenEstimate: 2_000,
        atomicGroupId: `segment-${String(index + 1)}`,
        compactionEligible: true,
        sourceAssistantMessageId: assistant.message.id,
        toolCallIds: [`call_segment_${String(index + 1)}`],
        toolResultMessageIds: [toolResult.message.id],
      };
    });
    const summaryInputs: ContextSummarizationInput[] = [];
    let summaryCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => ({ ...plan, selectedUnitIds: protocolUnits.map((unit) => unit.id) }) },
        {
          incrementalResolver: {
            resolve: () => ({
              newSourceMessages: sourceMessages,
              newSourceRange: sourceRange,
              cumulativeSourceRange: sourceRange,
            }),
          },
          enricher: createContextCheckpointEnricher(),
          summarizer: {
            async summarize(input) {
              summaryCalls += 1;
              summaryInputs.push(input);
              return {
                ...summary,
                semantic: {
                  ...summary.semantic,
                  completedWork: Array.from(
                    { length: summaryCalls },
                    (_, index) => `segment-${String(index + 1)}`,
                  ),
                },
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    const result = await coordinator.compact({
      ...request,
      history: {
        units: protocolUnits,
        openUnits: [],
        closedUnits: protocolUnits,
        estimatedTokens: 7_000,
      },
      policy: {
        effectiveInputLimitTokens: 5_000,
        outputReserveTokens: 20,
      } as never,
    });

    expect(
      result.kind,
      JSON.stringify({
        summaryCalls,
        priorCounts: summaryInputs.map((input) => input.previousCheckpoint?.completedWork),
      }),
    ).toBe("COMPACTED");
    expect(summaryCalls).toBeGreaterThan(1);
    expect(summaryInputs[1]?.previousCheckpoint?.completedWork).toContain("segment-1");
    expect(
      summaryInputs
        .flatMap((input) => input.sourceMessages)
        .map((stored) => stored.message.id)
        .sort(),
    ).toEqual(sourceMessages.map((stored) => stored.message.id).sort());
    for (let index = 0; index < 3; index += 1) {
      const assistantSequence = index * 2 + 2;
      const resultSequence = assistantSequence + 1;
      const segment = summaryInputs.find((input) =>
        input.sourceMessages.some((stored) => stored.sequence === assistantSequence),
      );
      expect(segment?.sourceMessages.some((stored) => stored.sequence === resultSequence)).toBe(
        true,
      );
    }
    if (result.kind === "COMPACTED") {
      expect(result.checkpoint.structuredCheckpoint.completedWork).toEqual(
        Array.from({ length: summaryCalls }, (_, index) => `segment-${String(index + 1)}`),
      );
      if (result.checkpoint.schemaVersion === 3) {
        expect(result.checkpoint.coverage.segments.at(-1)?.lastSequence).toBe(last.sequence);
      } else {
        expect(result.checkpoint.sourceRange.lastSequence).toBe(last.sequence);
      }
    }
  });

  it("reports a candidate above the hard input limit without committing", async () => {
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          tentativeRebuilder: {
            rebuild: async () => ({ estimatedInputTokens: 101, retainedMessageIds: [] }),
          },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(coordinator.compact(request)).resolves.toEqual({
      kind: "NOT_APPLICABLE",
      reason: "REQUEST_TOO_LARGE",
    });
    expect(commitCalls).toBe(0);
  });

  it("accepts a useful candidate above the soft V1 retention target", async () => {
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          tentativeRebuilder: {
            rebuild: async () => ({ estimatedInputTokens: 500, retainedMessageIds: [] }),
          },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(
      coordinator.compact({
        ...request,
        policy: {
          ...((request.policy ?? {}) as object),
          effectiveInputLimitTokens: 1_000,
          deepCompaction: {
            version: "DEEP_COMPACTION_V1",
            triggerRatio: 0.9,
            recentTokens: 10,
            checkpointMaxTokens: 320,
            boundaryTokens: 4,
          },
        } as never,
        estimatedInputTokensBefore: 2_000,
      }),
    ).resolves.toMatchObject({ kind: "COMPACTED", receipt: { retention: { status: "ELASTIC" } } });
    expect(commitCalls).toBe(1);
  });

  it("records actual freed tokens when the fitted candidate meets the retention target", async () => {
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          tentativeRebuilder: {
            rebuild: async () => ({ estimatedInputTokens: 42, retainedMessageIds: [] }),
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    const result = await coordinator.compact({ ...request, estimatedInputTokensBefore: 120 });

    expect(result).toMatchObject({
      kind: "COMPACTED",
      checkpoint: { tokensBefore: 120, tokensAfter: 42 },
      receipt: { tokensBefore: 120, tokensAfter: 42, actualFreedTokens: 78 },
    });
  });

  it("propagates summarizer infrastructure failures without fallback or commit", async () => {
    let fallbackCalls = 0;
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          summarizer: {
            summarize: async () => {
              throw new ContextSummarizationInfrastructureError("budget ledger failed");
            },
          },
          deterministicFallback: {
            build: () => {
              fallbackCalls += 1;
              return structuredCheckpoint;
            },
          },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(coordinator.compact(request)).rejects.toThrow("budget ledger failed");
    expect(fallbackCalls).toBe(0);
    expect(commitCalls).toBe(0);
  });

  it("propagates cancellation before facts and never commits", async () => {
    const controller = new AbortController();
    let commitCalls = 0;
    const coordinator = createContextCompactionCoordinator({
      dependencies: dependencies(
        { plan: () => plan },
        {
          factsProvider: {
            collect: async () => {
              controller.abort();
              return {
                readFiles: [],
                changedFiles: [],
                recentErrors: [],
                verificationState: "CURRENT",
                activeProcesses: [],
                pendingApprovals: [],
                resourceGovernance: "BOUNDED",
              };
            },
          },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return {
                checkpoint: { ...checkpoint, schemaVersion: 2 as const },
                events: events as never,
              };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(
      coordinator.compact({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(commitCalls).toBe(0);
  });
});
