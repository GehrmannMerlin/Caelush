import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import { createEventId, createSessionId } from "@caelush/protocol";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  createCheckpointContextSourceProvider,
  createContextCompactionEventFactory,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextMaterializer,
  createContextReceiptBuilder,
  createContextRehydrator,
  createContextRequestOverheadEstimator,
  createContextSourceRegistryBuilder,
  createCorePolicyContextSourceProvider,
  createConversationContextSourceProvider,
  createDeterministicCompactionFacts,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  type ContextCompactionCommitPort,
  type ContextSummarizationResult,
  type ContextSummarizerPort,
  type DeterministicCompactionFactsProvider,
} from "@caelush/agent";

import { snapshot, turn, turnIdFor, userMessage } from "../messages/fixtures.js";
import { createPromptSurfaceMemoryStore } from "./support/prompt-surface-memory-store.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-8c-engine" },
  api: "test-api",
  limits: { contextWindowTokens: 5_000, maxOutputTokens: 128 },
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

function acceptedResult(): ContextSummarizationResult {
  return {
    semantic: {
      goal: "current goal",
      constraints: [],
      completedWork: ["semantic work"],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      criticalReferences: [],
      nextIntent: "continue",
    },
    modelRef: MODEL.ref,
    finishReason: "STOP",
    summaryPromptVersion: 3,
    sourceDigest: "source",
    semanticDigest: "semantic",
  };
}

function compactionFixture(options: {
  readonly summarizer: ContextSummarizerPort;
  readonly factsProvider: DeterministicCompactionFactsProvider;
  readonly signal: AbortSignal;
}) {
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
  const tokenEstimator = createUtf8HeuristicTokenEstimator();
  let commitCalls = 0;
  let lastCheckpoint:
    Parameters<ContextCompactionCommitPort["commit"]>[0]["checkpoint"] | undefined;
  const compactionCommit: ContextCompactionCommitPort = {
    async commit(input) {
      commitCalls += 1;
      lastCheckpoint = input.checkpoint;
      return {
        checkpoint: Object.freeze({ ...input.checkpoint, schemaVersion: 2 as const }),
        events: [],
      };
    },
  };
  const engine = createV2ContextEngine({
    promptSurfaceStore: createPromptSurfaceMemoryStore(),
    sourceRegistry: registry,
    checkpointRepository: {
      async create() {
        throw new Error("not used");
      },
      async getLatestByRun() {
        return undefined;
      },
      async getById() {
        return undefined;
      },
      async listByRun() {
        return [];
      },
    },
    authorityProvider: {
      async snapshot() {
        return { goal: "current goal", verificationState: "CURRENT" };
      },
    },
    usageStore: {
      async upsert() {},
      async getByRun() {
        return undefined;
      },
    },
    compactionCommit,
    compactionEvents: createContextCompactionEventFactory(),
    checkpointIdFactory: { create: () => "ctx_phase_8c_boundary" },
    eventIdFactory: { create: createEventId },
    clock: { now: () => 1000 as never },
    policy: { outputReserveTokens: 128, safetyReserveTokens: 0 },
    requestOverheadEstimator: createContextRequestOverheadEstimator({
      tokenEstimator,
      protocolOverheadTokens: 500,
    }),
    summarizer: options.summarizer,
    deterministicFactsProvider: options.factsProvider,
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
    documentBuilder: createContextDocumentBuilder(),
    rehydrator: createContextRehydrator(),
    materializer: createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator,
    }),
    receiptBuilder: createContextReceiptBuilder({
      now: () => 1000 as never,
      tokenEstimator,
    }),
    tokenEstimator,
  });
  return {
    engine,
    input: {
      identity: {
        runId: historicalRunId as never,
        sessionId: createSessionId(),
        goal: "current goal",
      },
      turn: { stepId: "step:phase-8c-boundary" as never, sequence: 1 },
      conversation,
      input: { kind: "USER_INPUT" as const, userMessageId: current.message.id },
      model: MODEL,
      tools: [],
      mode: "NORMAL" as const,
      signal: options.signal,
    },
    get commitCalls() {
      return commitCalls;
    },
    get lastCheckpoint() {
      return lastCheckpoint;
    },
  };
}

function acceptedSummarizer(onAttempt?: () => void): ContextSummarizerPort {
  return {
    async summarize() {
      onAttempt?.();
      return acceptedResult();
    },
  };
}

function facts(): DeterministicCompactionFactsProvider {
  return {
    async collect() {
      return createDeterministicCompactionFacts({
        readFiles: [],
        changedFiles: [],
        recentErrors: [],
        verificationState: "CURRENT",
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "BOUNDED",
      });
    },
  };
}

describe("Phase 8C Context Engine failure boundaries", () => {
  it("throws facts infrastructure failure without committing a checkpoint", async () => {
    let factsCalls = 0;
    const fixture = compactionFixture({
      summarizer: acceptedSummarizer(),
      factsProvider: {
        async collect() {
          factsCalls += 1;
          throw new Error("facts infrastructure unavailable");
        },
      },
      signal: new AbortController().signal,
    });

    await expect(fixture.engine.prepare(fixture.input)).rejects.toThrow(
      "facts infrastructure unavailable",
    );
    expect(factsCalls).toBe(1);
    expect(fixture.commitCalls).toBe(0);
  });

  it("builds a degraded deterministic checkpoint for semantic fallback", async () => {
    const fixture = compactionFixture({
      summarizer: {
        async summarize() {
          throw new Error("provider failure");
        },
      },
      factsProvider: facts(),
      signal: new AbortController().signal,
    });

    await fixture.engine.prepare(fixture.input);

    expect(fixture.commitCalls).toBe(1);
    expect(fixture.lastCheckpoint?.degraded).toBe(true);
    expect(fixture.lastCheckpoint?.structuredCheckpoint.verificationState).toBe("CURRENT");
    expect(fixture.lastCheckpoint?.structuredCheckpoint.blocked).toContain(
      "Semantic summarization was unavailable; continue from deterministic durable state.",
    );
  });

  it("stops after semantic output is cancelled and never collects facts or commits", async () => {
    const controller = new AbortController();
    let factsCalls = 0;
    const fixture = compactionFixture({
      summarizer: acceptedSummarizer(() => controller.abort()),
      factsProvider: {
        async collect() {
          factsCalls += 1;
          return facts().collect({
            identity: fixture.input.identity,
            sourceRange: {} as never,
            signal: controller.signal,
          });
        },
      },
      signal: controller.signal,
    });

    await expect(fixture.engine.prepare(fixture.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(factsCalls).toBe(0);
    expect(fixture.commitCalls).toBe(0);
  });

  it("does not invoke semantic summary, facts, or commit when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let summaryCalls = 0;
    let factsCalls = 0;
    const fixture = compactionFixture({
      summarizer: acceptedSummarizer(() => {
        summaryCalls += 1;
      }),
      factsProvider: {
        async collect() {
          factsCalls += 1;
          return facts().collect({
            identity: fixture.input.identity,
            sourceRange: {} as never,
            signal: controller.signal,
          });
        },
      },
      signal: controller.signal,
    });

    await expect(fixture.engine.prepare(fixture.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(summaryCalls).toBe(0);
    expect(factsCalls).toBe(0);
    expect(fixture.commitCalls).toBe(0);
  });
});
