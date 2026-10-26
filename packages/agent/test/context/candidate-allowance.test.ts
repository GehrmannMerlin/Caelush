import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  createContextCheckpointId,
  createContextCompactionEventFactory,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextMaterializer,
  createContextMessageRange,
  createContextPlanner,
  createContextReceiptBuilder,
  createContextRehydrator,
  createContextRequestOverheadEstimator,
  createContextSourceRegistryBuilder,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  createStandardAgentMessageProjectorRegistry,
  createContextSummaryPromptVersion,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  estimateAIMessages,
  resolveTurnBudgetPolicy,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type ContextUsageStorePort,
  type StoredAgentMessage,
} from "@caelush/agent";
import { createEventId } from "@caelush/protocol";

import { assistantMessage, snapshot, turn, userMessage } from "../messages/fixtures.js";
import { createPromptSurfaceMemoryStore } from "./support/prompt-surface-memory-store.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "candidate-allowance" },
  api: "test-api",
  limits: { contextWindowTokens: 40_000, maxOutputTokens: 20_000 },
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

const POLICY = {
  ...resolveTurnBudgetPolicy({
    contextWindowTokens: MODEL.limits.contextWindowTokens,
    maxOutputTokens: MODEL.limits.maxOutputTokens,
  }),
  outputRecovery: {
    version: "OUTPUT_RECOVERY_V1" as const,
    maxRecoveryTurns: 1 as const,
    outputMultiplier: 2 as const,
  },
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

function checkpointCovering(message: StoredAgentMessage): ContextCheckpointRecordV2 {
  return {
    checkpointId: createContextCheckpointId("checkpoint_candidate_coverage"),
    runId: message.message.runId,
    schemaVersion: 2,
    sourceRange: createContextMessageRange({
      runId: message.message.runId,
      conversationTurnId: message.message.conversationTurnId,
      firstMessageId: message.message.id,
      lastMessageId: message.message.id,
      firstSequence: message.sequence,
      lastSequence: message.sequence,
    }),
    structuredCheckpoint: {
      version: 1,
      goal: "covered",
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
      sourceRange: { from: message.sequence, to: message.sequence },
    },
    tokensBefore: 5_000,
    tokensAfter: 100,
    modelRef: MODEL.ref,
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "source",
    checkpointDigest: "checkpoint",
    degraded: false,
    reason: "PROACTIVE_PRESSURE",
    createdAt: 1 as never,
  };
}

function usageStore(
  captured?: { lastRecoveryStages?: readonly string[] }[],
): ContextUsageStorePort {
  return {
    async upsert(snapshot) {
      captured?.push(snapshot as { lastRecoveryStages?: readonly string[] });
    },
    async getByRun() {
      return undefined;
    },
  };
}

function createEngine(input: {
  readonly candidateMessageEstimator?: (messages: readonly StoredAgentMessage[]) => number;
  readonly latestCheckpoint?: ContextCheckpointRecordV2;
  readonly received?: StoredAgentMessage[][];
  readonly captured?: { lastRecoveryStages?: readonly string[] }[];
}) {
  const tokenEstimator = createUtf8HeuristicTokenEstimator();
  const registry = createContextSourceRegistryBuilder()
    .register({
      id: AGENT_CONTEXT_SOURCE_IDS.conversation,
      priority: 20,
      criticality: "REQUIRED",
      provider: createConversationContextSourceProvider(),
    })
    .register({
      id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
      priority: 0,
      criticality: "REQUIRED",
      provider: createCorePolicyContextSourceProvider({ text: "Current task policy." }),
    })
    .build();

  return createV2ContextEngine({
    promptSurfaceStore: createPromptSurfaceMemoryStore(),
    turnBudgetPolicy: POLICY,
    ...(input.candidateMessageEstimator === undefined
      ? {}
      : {
          candidateMessageEstimator: (messages: readonly StoredAgentMessage[]) => {
            input.received?.push([...messages]);
            return input.candidateMessageEstimator?.(messages) ?? 0;
          },
        }),
    sourceRegistry: registry,
    checkpointRepository: checkpointRepository(input.latestCheckpoint),
    authorityProvider: {
      async snapshot() {
        return { goal: "current goal", verificationState: "NOT_RUN" as const };
      },
    },
    usageStore: usageStore(input.captured),
    requestOverheadEstimator: createContextRequestOverheadEstimator({
      tokenEstimator,
      protocolOverheadTokens: 7,
    }),
    historyIndexer: createContextHistoryIndexer(),
    planner: createContextPlanner(),
    rehydrator: createContextRehydrator(),
    documentBuilder: createContextDocumentBuilder(),
    materializer: createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator,
    }),
    receiptBuilder: createContextReceiptBuilder({ now: () => 1000 as never, tokenEstimator }),
    tokenEstimator,
    clock: { now: () => 1000 as never },
    compactionEvents: createContextCompactionEventFactory(),
    eventIdFactory: { create: createEventId },
  });
}

async function prepare(
  engine: ReturnType<typeof createEngine>,
  messages: readonly StoredAgentMessage[],
  mode: "NORMAL" | "FORCED_RECOVERY" = "NORMAL",
) {
  const first = messages[0]!.message;
  return engine.prepare({
    identity: { runId: first.runId, sessionId: first.sessionId, goal: "current goal" },
    turn: { stepId: "step:candidate-allowance" as never, sequence: 1 },
    conversation: snapshot([turn([...messages])]),
    input: { kind: "USER_INPUT", userMessageId: messages.at(-1)?.message.id as never },
    model: MODEL,
    tools: [],
    mode,
    signal: new AbortController().signal,
  });
}

describe("candidate output allowance", () => {
  it("prices the wire shape, not the durable record", () => {
    const assistant = assistantMessage({ text: "x".repeat(4_000) });
    const tokenEstimator = createUtf8HeuristicTokenEstimator();
    const registry = createStandardAgentMessageProjectorRegistry();
    const wire = registry.project(assistant).messages;

    const wireTokens = estimateAIMessages(wire, MODEL, tokenEstimator);
    const recordTokens = tokenEstimator.estimateAgentMessage(assistant.message, MODEL);

    expect(wireTokens).toBeGreaterThan(0);
    expect(wireTokens).toBeLessThan(recordTokens);
  });

  it("grants the preferred allowance when the candidate set leaves room", async () => {
    const user = userMessage({ text: "current intent" });
    const prepared = await prepare(createEngine({ candidateMessageEstimator: () => 5_000 }), [
      user,
    ]);

    expect(prepared.requestBudget.version).toBe("TURN_BUDGET_V3");
    if (prepared.requestBudget.version !== "TURN_BUDGET_V3") return;
    expect(prepared.requestBudget.outputAllowanceTokens).toBe(POLICY.preferredOutputTokens);
  });

  it("falls back to the floor when the candidate set really fills the window", async () => {
    const user = userMessage({ text: "current intent" });
    const prepared = await prepare(createEngine({ candidateMessageEstimator: () => 40_000 }), [
      user,
    ]);

    expect(prepared.requestBudget.version).toBe("TURN_BUDGET_V3");
    if (prepared.requestBudget.version !== "TURN_BUDGET_V3") return;
    expect(prepared.requestBudget.outputAllowanceTokens).toBe(POLICY.minOutputTokens);
  });

  it("excludes a covered message from the candidate set so compaction can raise the allowance", async () => {
    const assistant = assistantMessage({ text: "y".repeat(2_000), sequence: 1 });
    const user = userMessage({ text: "current intent", sequence: 2 });
    const received: StoredAgentMessage[][] = [];
    const engine = createEngine({
      candidateMessageEstimator: () => 5_000,
      latestCheckpoint: checkpointCovering(assistant),
      received,
    });

    await prepare(engine, [assistant, user]);

    const candidateIds = received.flat().map((stored) => stored.message.id);
    expect(candidateIds).not.toContain(assistant.message.id);
    expect(candidateIds).toContain(user.message.id);
  });
});

describe("compaction skip trace", () => {
  it("records why a forced recovery could not plan a compaction", async () => {
    const assistant = assistantMessage({ text: "a".repeat(200), sequence: 1 });
    const user = userMessage({ text: "current intent", sequence: 2 });
    const captured: { lastRecoveryStages?: readonly string[] }[] = [];

    await prepare(createEngine({ captured }), [assistant, user], "FORCED_RECOVERY");

    const stages = captured.at(-1)?.lastRecoveryStages ?? [];
    // Nothing is foldable in a single open turn with no closed protocol batch, and the reason now
    // rides on the same durable channel as the recovery stages instead of vanishing.
    expect(stages).toContain("COMPACTION_SKIP_NO_CLOSED_TURN");
    expect(stages).not.toContain("COMPACT_HISTORY");
  });
});
