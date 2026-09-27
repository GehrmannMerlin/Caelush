import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  createCheckpointContextSourceProvider,
  createContextCheckpointId,
  createContextCompactionEventFactory,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextItemId,
  createContextMaterializer,
  createContextMessageRange,
  createContextPlanner,
  createContextReceiptBuilder,
  createContextRehydrator,
  createContextRequestOverheadEstimator,
  createContextSourceItem,
  createContextSourceRegistryBuilder,
  createContextSummaryPromptVersion,
  createDeterministicCompactionFacts,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  createStructuredCheckpoint,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  type ContextAuthorityProviderPort,
  type ContextCompactionCommitPort,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type StoredAgentMessage,
  type ContextUsageSnapshot,
  type ContextUsageStorePort,
  type DeterministicCompactionFactsProvider,
} from "@caelush/agent";
import { createEventId, createRunId, createSessionId } from "@caelush/protocol";

import { snapshot, turn, turnIdFor, userMessage } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7f" },
  api: "test-api",
  limits: { contextWindowTokens: 2_000, maxOutputTokens: 128 },
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

function checkpointRepository(latest?: ContextCheckpointRecordV2): ContextCheckpointRepositoryPort {
  return {
    async create() {
      if (latest === undefined) throw new Error("not used");
      return latest;
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

function checkpointForMessage(message: StoredAgentMessage): ContextCheckpointRecordV2 {
  const sourceRange = createContextMessageRange({
    runId: message.message.runId,
    conversationTurnId: message.message.conversationTurnId,
    firstMessageId: message.message.id,
    lastMessageId: message.message.id,
    firstSequence: message.sequence,
    lastSequence: message.sequence,
  });
  return {
    checkpointId: createContextCheckpointId("checkpoint_phase_8b_existing"),
    runId: message.message.runId,
    schemaVersion: 2,
    sourceRange,
    structuredCheckpoint: createStructuredCheckpoint({
      version: 1,
      goal: "existing checkpoint",
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "NOT_RUN",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "UNKNOWN",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: message.sequence, to: message.sequence },
    }),
    tokensBefore: 100,
    tokensAfter: 10,
    modelRef: MODEL.ref,
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "source",
    checkpointDigest: "checkpoint",
    degraded: false,
    reason: "SELECTION_PRESSURE",
    createdAt: 1 as never,
  };
}

function usageStore(): ContextUsageStorePort & { readonly values: ContextUsageSnapshot[] } {
  const values: ContextUsageSnapshot[] = [];
  return {
    values,
    async upsert(value) {
      values.push(value);
    },
    async getByRun() {
      return values.at(-1);
    },
  };
}

describe("Phase 7F production-capable Agent ContextEngine", () => {
  it("prepares semantic sources through one final materialization and persists one audit fact set", async () => {
    const current = userMessage({ text: "current intent" });
    const conversation = snapshot([turn([current])]);
    const usage = usageStore();
    let authoritySnapshotCount = 0;
    const authority: ContextAuthorityProviderPort = {
      async snapshot() {
        authoritySnapshotCount += 1;
        return {
          goal: "current goal",
          changedFiles: ["src/current.ts"],
          verificationState: "NOT_RUN",
        };
      },
    };
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.conversation,
        priority: 20,
        criticality: "REQUIRED",
        provider: createConversationContextSourceProvider(),
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
        priority: 90,
        criticality: "OPTIONAL",
        provider: {
          id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
          async collect(input) {
            void input;
            return {
              providerId: AGENT_CONTEXT_SOURCE_IDS.branchContext,
              providerVersion: "test",
              items: [
                createContextSourceItem({
                  id: createContextItemId("agent.branch-context:test"),
                  type: "agent.branch-context",
                  source: {
                    providerId: AGENT_CONTEXT_SOURCE_IDS.branchContext,
                    sourceRef: "branch:none",
                    version: "test",
                  },
                  scope: "RUN",
                  retention: "RETRIEVABLE",
                  priorityClass: "LOW",
                  tokenEstimate: 1,
                  cacheStability: "DYNAMIC",
                  freshness: "CURRENT",
                  sensitivity: "INTERNAL",
                  whyLoaded: "test branch context",
                  payload: { kind: "TEXT", text: "branch" },
                }),
              ],
              diagnostics: [],
            };
          },
        },
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
        priority: 0,
        criticality: "REQUIRED",
        provider: createCorePolicyContextSourceProvider({
          text: "You are Caelush. Follow the current task and respect policy.",
        }),
      })
      .build();
    const projectors = createStandardAgentMessageProjectorRegistry();
    const estimator = createUtf8HeuristicTokenEstimator();
    const engine = createV2ContextEngine({
      sourceRegistry: registry,
      checkpointRepository: checkpointRepository(),
      authorityProvider: authority,
      usageStore: usage,
      policy: { outputReserveTokens: 128, safetyReserveTokens: 0 },
      requestOverheadEstimator: createContextRequestOverheadEstimator({
        tokenEstimator: estimator,
        protocolOverheadTokens: 7,
      }),
      historyIndexer: createContextHistoryIndexer(),
      planner: createContextPlanner(),
      rehydrator: createContextRehydrator(),
      documentBuilder: createContextDocumentBuilder(),
      materializer: createContextMaterializer({ projectors, tokenEstimator: estimator }),
      receiptBuilder: createContextReceiptBuilder({
        now: () => 1000 as never,
        tokenEstimator: estimator,
      }),
      tokenEstimator: estimator,
      clock: { now: () => 1000 as never },
    });

    const prepared = await engine.prepare({
      identity: { runId: createRunId(), sessionId: createSessionId(), goal: "current goal" },
      turn: { stepId: "step:phase-7f" as never, sequence: 1 },
      conversation,
      input: { kind: "USER_INPUT", userMessageId: current.message.id },
      model: MODEL,
      tools: [],
      mode: "NORMAL",
      signal: new AbortController().signal,
    });

    expect(prepared.messages[0]).toMatchObject({ role: "system" });
    expect(prepared.messages[0]?.content).toContain("You are Caelush");
    expect(
      prepared.messages.some(
        (message) => message.role === "user" && message.content === "current intent",
      ),
    ).toBe(true);
    expect(prepared.contextFingerprint).toMatch(/^sha256:/);
    expect(prepared.report.requestOverheadTokens).toBe(7);
    expect(prepared.report.estimatedInputTokens).toBeLessThanOrEqual(
      prepared.report.effectiveInputLimitTokens,
    );
    expect(usage.values).toHaveLength(1);
    expect(usage.values[0]?.contextFingerprint).toBe(prepared.contextFingerprint);
    expect(authoritySnapshotCount).toBe(1);
  });

  it("commits compaction facts atomically before notifying and removes the covered tail", async () => {
    const historicalRunId = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
    const currentRunId = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
    const historicalTurnId = turnIdFor(historicalRunId);
    const currentTurnId = turnIdFor(currentRunId);
    const historical = [
      userMessage({
        runId: historicalRunId,
        turnId: historicalTurnId,
        sequence: 1,
        text: "historical intent ".repeat(800),
      }),
      userMessage({
        runId: historicalRunId,
        turnId: historicalTurnId,
        sequence: 2,
        text: "historical evidence ".repeat(200),
      }),
    ];
    const current = userMessage({
      runId: currentRunId,
      turnId: currentTurnId,
      sequence: 10,
      text: "current intent ".repeat(725),
    });
    const conversation = snapshot(
      [
        turn(historical, { runId: historicalRunId, status: "CLOSED" }),
        turn([current], { runId: currentRunId, openedAt: 2 }),
      ],
      { runId: currentRunId },
    );
    const usage = usageStore();
    let verificationState = "OLD";
    let capturedRehydrationAuthority: string | undefined;
    let authoritySnapshotCount = 0;
    const authority: ContextAuthorityProviderPort = {
      async snapshot() {
        authoritySnapshotCount += 1;
        if (authoritySnapshotCount === 1) expect(commitFinished).toBe(false);
        else expect(commitFinished).toBe(true);
        return { goal: "current goal", verificationState };
      },
    };
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.conversation,
        priority: 20,
        criticality: "REQUIRED",
        provider: createConversationContextSourceProvider(),
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.checkpoint,
        priority: 30,
        criticality: "REQUIRED",
        provider: createCheckpointContextSourceProvider(),
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
        priority: 0,
        criticality: "REQUIRED",
        provider: createCorePolicyContextSourceProvider({ text: "Core policy" }),
      })
      .build();
    const estimator = createUtf8HeuristicTokenEstimator();
    const committed: { eventCount: number } = { eventCount: 0 };
    let summaryTargetTokens: number | undefined;
    let summarySourceSequences: readonly number[] | undefined;
    let summarySourceRange:
      { readonly firstSequence: number; readonly lastSequence: number } | undefined;
    let summaryFinished = false;
    const factsProvider: DeterministicCompactionFactsProvider = {
      async collect(input) {
        expect(summaryFinished).toBe(true);
        expect(commitFinished).toBe(false);
        expect(input.sourceRange).toMatchObject({ firstSequence: 1, lastSequence: 2 });
        return createDeterministicCompactionFacts({
          readFiles: ["packages/agent/src/context/engine/context-engine.ts"],
          changedFiles: ["packages/agent/src/context/engine/context-engine.ts"],
          recentErrors: [],
          verificationState: "NOT_RUN",
          activeProcesses: [],
          pendingApprovals: [],
          resourceGovernance: "bounded",
        });
      },
    };
    const existingCheckpoint = checkpointForMessage(historical[0]!);
    let commitFinished = false;
    let notificationObservedAfterCommit = false;
    const compactionCommit: ContextCompactionCommitPort = {
      async commit(input) {
        committed.eventCount = input.events.length;
        const checkpoint = Object.freeze({ ...input.checkpoint, schemaVersion: 2 as const });
        commitFinished = true;
        return {
          checkpoint,
          events: input.events.map((event) => ({
            ...event,
            durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 1 },
          })),
        };
      },
    };
    const engine = createV2ContextEngine({
      sourceRegistry: registry,
      checkpointRepository: checkpointRepository(existingCheckpoint),
      authorityProvider: authority,
      usageStore: usage,
      compactionCommit,
      notifier: {
        notifyCommitted() {
          notificationObservedAfterCommit = commitFinished;
        },
        emitTransient() {
          // The compaction test only exercises the durable post-commit notification.
        },
      },
      compactionEvents: createContextCompactionEventFactory(),
      checkpointIdFactory: { create: () => "ctx_phase_7f" },
      eventIdFactory: { create: createEventId },
      deterministicFactsProvider: factsProvider,
      clock: { now: () => 1000 as never },
      policy: { outputReserveTokens: 128, safetyReserveTokens: 0 },
      requestOverheadEstimator: createContextRequestOverheadEstimator({
        tokenEstimator: estimator,
        protocolOverheadTokens: 500,
      }),
      summarizer: {
        async summarize(input) {
          summaryTargetTokens = input.targetTokens;
          summarySourceSequences = input.sourceMessages.map((message) => message.sequence);
          summarySourceRange = input.sourceRange;
          summaryFinished = true;
          verificationState = "NEW";
          return {
            semantic: {
              goal: input.identity.goal,
              constraints: [],
              completedWork: ["historical context compacted"],
              inProgress: [],
              blocked: [],
              importantDiscoveries: [],
              keyDecisions: [],
              criticalReferences: [],
              nextIntent: "Continue current intent.",
            },
            modelRef: input.model.ref,
            finishReason: "STOP",
            summaryPromptVersion: 2,
            sourceDigest: "source",
            semanticDigest: "semantic",
          };
        },
      },
      checkpointBudgetResolver: {
        resolve() {
          return { targetTokens: 7, maxTokens: 10 };
        },
      },
      compactionGainEvaluator: {
        evaluate() {
          return {
            selectedTokens: 100,
            estimatedCheckpointTokens: 10,
            estimatedFreedTokens: 90,
            gainRatio: 0.9,
          };
        },
      },
      historyIndexer: createContextHistoryIndexer(),
      planner: createContextPlanner(),
      rehydrator: {
        async rehydrate(input) {
          capturedRehydrationAuthority = input.authorities.verificationState;
          return await createContextRehydrator().rehydrate(input);
        },
      },
      documentBuilder: createContextDocumentBuilder(),
      materializer: createContextMaterializer({
        projectors: createStandardAgentMessageProjectorRegistry(),
        tokenEstimator: estimator,
      }),
      receiptBuilder: createContextReceiptBuilder({
        now: () => 1000 as never,
        tokenEstimator: estimator,
      }),
      tokenEstimator: estimator,
    });

    const prepared = await engine.prepare({
      identity: {
        runId: historicalRunId as never,
        sessionId: createSessionId(),
        goal: "current goal",
      },
      turn: { stepId: "step:phase-7f-compaction" as never, sequence: 1 },
      conversation,
      input: { kind: "USER_INPUT", userMessageId: current.message.id },
      model: { ...MODEL, limits: { contextWindowTokens: 5_000, maxOutputTokens: 128 } },
      tools: [],
      mode: "NORMAL",
      signal: new AbortController().signal,
    });

    expect(committed.eventCount).toBe(1);
    expect(authoritySnapshotCount).toBe(2);
    expect(summaryTargetTokens).toBe(7);
    expect(summarySourceSequences).toEqual([2]);
    expect(summarySourceRange).toMatchObject({ firstSequence: 1, lastSequence: 2 });
    expect(notificationObservedAfterCommit).toBe(true);
    expect(capturedRehydrationAuthority).toBe("NEW");
    expect(
      prepared.messages.some(
        (message) => message.role === "user" && message.content.includes("current intent"),
      ),
    ).toBe(true);
    expect(
      prepared.messages.some(
        (message) => message.role === "user" && message.content.includes("historical intent"),
      ),
    ).toBe(false);
    expect(prepared.messages[0]).toMatchObject({ role: "system" });
    expect(prepared.messages[0]?.content).toContain("historical context compacted");
    expect(prepared.messages[0]?.content).toContain(
      "packages/agent/src/context/engine/context-engine.ts",
    );
    expect(prepared.checkpoint?.schemaVersion).toBe(2);
    expect(prepared.checkpoint?.sourceRange).toMatchObject({
      firstSequence: 1,
      lastSequence: 2,
    });
  });
});
