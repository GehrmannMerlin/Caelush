import { describe, expect, it } from "vitest";

import {
  createContextCompactionCoordinator,
  createContextMessageRange,
  createStructuredCheckpoint,
  type ContextCompactionDependencies,
  type ContextCompactionPlan,
  type ContextCompactionRequest,
  type ContextCheckpointIdFactory,
  type ContextSummarizationResult,
} from "@caelush/agent";

const request = {
  identity: { runId: "run_phase_8e" as never, sessionId: "session_phase_8e" as never, goal: "goal" },
  conversation: {} as never,
  history: {} as never,
  policy: { effectiveInputLimitTokens: 100 } as never,
  model: { ref: { provider: "test", model: "phase-8e" } } as never,
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
  cut: { kind: "TURN_BOUNDARY", firstKeptTurnId: "turn_kept", firstKeptMessageId: "message_kept", firstKeptSequence: 3 },
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
    goal: "goal",
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
  summaryPromptVersion: 2,
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
    checkpointBudget: { resolve: () => ({ targetTokens: 5, maxTokens: 8 }) },
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
    tentativeRebuilder: { rebuild: async () => ({ estimatedInputTokens: 42, retainedMessageIds: [] }) },
    commit: {
      commit: async ({ checkpoint, events }) => ({
        checkpoint: { ...checkpoint, schemaVersion: 2 as const },
        events,
      }),
    },
    clock: { now: () => 1 as never },
    checkpointIdFactory,
    ...overrides,
  };
}

describe("Phase 8E ContextCompactionCoordinator", () => {
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
          summarizer: { summarize: async () => { summaryCalls += 1; return summary; } },
          commit: {
            commit: async ({ checkpoint, events }) => {
              commitCalls += 1;
              return { checkpoint: { ...checkpoint, schemaVersion: 2 as const }, events };
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
    }
    expect(summaryCalls).toBe(1);
    expect(commitCalls).toBe(1);
  });

  it("maps a candidate that is still too large to INSUFFICIENT_GAIN without committing", async () => {
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
              return { checkpoint: { ...checkpoint, schemaVersion: 2 as const }, events };
            },
          },
        },
      ),
      latest: { kind: "NONE" },
    });

    await expect(coordinator.compact(request)).resolves.toEqual({
      kind: "NOT_APPLICABLE",
      reason: "INSUFFICIENT_GAIN",
    });
    expect(commitCalls).toBe(0);
  });
});
