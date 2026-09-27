import { describe, expect, it } from "vitest";

import type { AIMessage, ModelDescriptor } from "@caelush/ai";
import { createEventId, createSessionId } from "@caelush/protocol";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  createCheckpointContextSourceProvider,
  createContextCompactionEventFactory,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextReceiptBuilder,
  createContextSourceRegistryBuilder,
  createCorePolicyContextSourceProvider,
  createConversationContextSourceProvider,
  createDeterministicCompactionFacts,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  type ContextCompactionCommitPort,
  type ContextMaterializer,
  type ContextPrepareInput,
  type ContextSummarizationResult,
  type DeterministicCompactionFactsProvider,
} from "@caelush/agent";

import { snapshot, turn, turnIdFor, userMessage } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-8d-engine" },
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
    summaryPromptVersion: 2,
    sourceDigest: "semantic-source",
    semanticDigest: "semantic",
  };
}

function factsProvider(): DeterministicCompactionFactsProvider {
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

function fixture(
  options: {
    readonly materializer?: ContextMaterializer;
    readonly authority?: (call: number) => Record<string, string>;
    readonly policy?: {
      readonly outputReserveTokens?: number;
      readonly safetyReserveTokens?: number;
    };
    readonly signal?: AbortSignal;
  } = {},
) {
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
  let notifierCalls = 0;
  let usageCalls = 0;
  let authorityCalls = 0;
  let lastCheckpoint: Parameters<ContextCompactionCommitPort["commit"]>[0]["checkpoint"];
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
        authorityCalls += 1;
        return (
          options.authority?.(authorityCalls) ?? {
            goal: "current goal",
            verificationState: "CURRENT",
          }
        );
      },
    },
    usageStore: {
      async upsert() {
        usageCalls += 1;
      },
      async getByRun() {
        return undefined;
      },
    },
    compactionCommit,
    notifier: {
      notifyCommitted() {
        notifierCalls += 1;
      },
      emitTransient() {},
    },
    compactionEvents: createContextCompactionEventFactory(),
    checkpointIdFactory: { create: () => "ctx_phase_8d_candidate" },
    eventIdFactory: { create: createEventId },
    clock: { now: () => 1000 as never },
    policy: options.policy ?? { outputReserveTokens: 128, safetyReserveTokens: 0 },
    requestOverheadEstimator: {
      estimate: () => ({
        toolSchemaTokens: 0,
        protocolOverheadTokens: 500,
        totalTokens: 500,
      }),
    },
    summarizer: {
      async summarize() {
        return acceptedResult();
      },
    },
    deterministicFactsProvider: factsProvider(),
    checkpointBudgetResolver: { resolve: () => ({ targetTokens: 7, maxTokens: 10 }) },
    compactionGainEvaluator: {
      evaluate: () => ({
        selectedTokens: 100,
        estimatedCheckpointTokens: 10,
        estimatedFreedTokens: 90,
        gainRatio: 0.9,
      }),
    },
    historyIndexer: createContextHistoryIndexer(),
    documentBuilder: createContextDocumentBuilder(),
    materializer: options.materializer ?? {
      async materialize({ prepared }) {
        return [
          {
            role: "system",
            content: prepared.document.sections.map((section) => section.text).join("|"),
          },
        ];
      },
    },
    receiptBuilder: createContextReceiptBuilder({ now: () => 1000 as never, tokenEstimator }),
    tokenEstimator,
  });
  const input: ContextPrepareInput = {
    identity: {
      runId: historicalRunId as never,
      sessionId: createSessionId(),
      goal: "current goal",
    },
    turn: { stepId: "step:phase-8d-engine" as never, sequence: 1 },
    conversation,
    input: { kind: "USER_INPUT", userMessageId: current.message.id },
    model: MODEL,
    tools: [],
    mode: "NORMAL",
    signal: options.signal ?? new AbortController().signal,
  };
  return {
    engine,
    input,
    get commitCalls() {
      return commitCalls;
    },
    get notifierCalls() {
      return notifierCalls;
    },
    get usageCalls() {
      return usageCalls;
    },
    get authorityCalls() {
      return authorityCalls;
    },
    get lastCheckpoint() {
      return lastCheckpoint;
    },
  };
}

describe("Phase 8D tentative rebuild and durable fit", () => {
  it("rebuilds before commit and persists the materialized estimate, not retained planner tokens", async () => {
    const fixtureState = fixture();
    const result = await fixtureState.engine.prepare(fixtureState.input);

    expect(fixtureState.commitCalls).toBe(1);
    expect(fixtureState.authorityCalls).toBe(2);
    expect(fixtureState.lastCheckpoint?.tokensAfter).toBe(result.report.estimatedInputTokens);
    expect(fixtureState.lastCheckpoint?.tokensAfter).not.toBe(0);
    expect(fixtureState.usageCalls).toBe(1);
  });

  it("does not commit a candidate whose production rebuild is over the effective limit", async () => {
    const materializer: ContextMaterializer = {
      async materialize(): Promise<readonly AIMessage[]> {
        return [{ role: "system", content: "x".repeat(30_000) }];
      },
    };
    const fixtureState = fixture({ materializer });

    await expect(fixtureState.engine.prepare(fixtureState.input)).rejects.toThrow();
    expect(fixtureState.commitCalls).toBe(0);
    expect(fixtureState.notifierCalls).toBe(0);
    expect(fixtureState.usageCalls).toBe(0);
  });

  it("uses a fresh post-commit authority snapshot after tentative authority", async () => {
    const documents: string[] = [];
    const materializer: ContextMaterializer = {
      async materialize({ prepared }) {
        documents.push(prepared.document.sections.map((section) => section.text).join("|"));
        return [{ role: "system", content: "stable" }];
      },
    };
    const fixtureState = fixture({
      materializer,
      authority: (call) => ({ goal: call === 1 ? "authority-A" : "authority-B" }),
    });

    await fixtureState.engine.prepare(fixtureState.input);

    expect(fixtureState.authorityCalls).toBe(2);
    expect(documents[0]).toContain("authority-A");
    expect(documents.at(-1)).toContain("authority-B");
  });

  it("uses the same selected durable conversation IDs for tentative and final builds", async () => {
    const selections: string[][] = [];
    const materializer: ContextMaterializer = {
      async materialize({ prepared }) {
        selections.push(prepared.conversationMessages.map((message) => String(message.message.id)));
        return [{ role: "system", content: "stable" }];
      },
    };
    const fixtureState = fixture({ materializer });

    await fixtureState.engine.prepare(fixtureState.input);

    expect(selections).toHaveLength(2);
    expect(selections[0]).toEqual(selections[1]);
    const userMessageId =
      fixtureState.input.input.kind === "USER_INPUT"
        ? fixtureState.input.input.userMessageId
        : undefined;
    expect(selections[0]).toContain(String(userMessageId));
  });

  it("propagates abort during tentative materialization without durable side effects", async () => {
    const controller = new AbortController();
    const materializer: ContextMaterializer = {
      async materialize(): Promise<readonly AIMessage[]> {
        controller.abort();
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    };
    const fixtureState = fixture({ materializer, signal: controller.signal });

    await expect(fixtureState.engine.prepare(fixtureState.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fixtureState.commitCalls).toBe(0);
    expect(fixtureState.notifierCalls).toBe(0);
    expect(fixtureState.usageCalls).toBe(0);
  });

  it("does not commit when tentative materialization fails", async () => {
    const materializer: ContextMaterializer = {
      async materialize(): Promise<readonly AIMessage[]> {
        throw new Error("materializer unavailable");
      },
    };
    const fixtureState = fixture({ materializer });

    await expect(fixtureState.engine.prepare(fixtureState.input)).rejects.toThrow(
      "materializer unavailable",
    );
    expect(fixtureState.commitCalls).toBe(0);
    expect(fixtureState.notifierCalls).toBe(0);
    expect(fixtureState.usageCalls).toBe(0);
  });
});
