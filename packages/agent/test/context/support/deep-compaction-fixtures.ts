import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextCheckpointEnricher,
  createContextCompactionCoordinator,
  createContextHistoryIndexer,
  createContextMessageRange,
  createDeterministicCheckpointBuilder,
  createStructuredCheckpoint,
  agentMessageId,
  conversationTurnId,
  type ContextCompactionDependencies,
  type ContextCompactionPlan,
  type ContextCompactionRequest,
  type ContextHistoryIndex,
  type ContextPolicy,
  type StoredAgentMessage,
} from "@caelush/agent";
import { createRunId, createSessionId } from "@caelush/protocol";

import {
  assistantMessage,
  snapshot,
  toolResultMessage,
  turn,
  turnIdFor,
  userMessage,
} from "../../messages/fixtures.js";

export const DEEP_COMPACTION_MODEL = {
  ref: { provider: "fixture", model: "deep-compaction" },
  api: "fixture-api",
  limits: { contextWindowTokens: 1_048_576, maxOutputTokens: 393_216 },
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
} satisfies ModelDescriptor;

const SESSION_ID = createSessionId("ses_0192f5b1-4d3a-7c2e-8a91-00000000d001");
const RUN_A = createRunId("run_0192f5b1-4d3a-7c2e-8a91-00000000d001");
const RUN_B = createRunId("run_0192f5b1-4d3a-7c2e-8a91-00000000d002");
const RUN_C = createRunId("run_0192f5b1-4d3a-7c2e-8a91-00000000d003");

export interface MultiRunCompactionFixture {
  readonly sessionId: ReturnType<typeof createSessionId>;
  readonly runIds: readonly [
    ReturnType<typeof createRunId>,
    ReturnType<typeof createRunId>,
    ReturnType<typeof createRunId>,
  ];
  readonly conversation: ReturnType<typeof snapshot>;
  readonly history: ContextHistoryIndex;
  readonly expectedOldUnitIds: readonly string[];
  readonly currentUnitId: string;
}

export function createMultiRunCompactionFixture(): MultiRunCompactionFixture {
  const turnA = turn(
    [
      userMessage({ runId: RUN_A, sessionId: SESSION_ID, sequence: 1, text: "A".repeat(1_200) }),
      assistantMessage({ runId: RUN_A, sessionId: SESSION_ID, sequence: 2, text: "A completed" }),
    ],
    { runId: RUN_A, sessionId: SESSION_ID, status: "CLOSED", openedAt: 1 },
  );
  const turnB = turn(
    [
      userMessage({ runId: RUN_B, sessionId: SESSION_ID, sequence: 1, text: "B".repeat(1_200) }),
      assistantMessage({ runId: RUN_B, sessionId: SESSION_ID, sequence: 2, text: "B completed" }),
    ],
    { runId: RUN_B, sessionId: SESSION_ID, status: "CLOSED", openedAt: 2 },
  );
  const currentTurn = turn(
    [userMessage({ runId: RUN_C, sessionId: SESSION_ID, sequence: 1, text: "current request" })],
    { runId: RUN_C, sessionId: SESSION_ID, status: "OPEN", openedAt: 3 },
  );
  const conversation = snapshot([turnA, turnB, currentTurn], {
    runId: RUN_C,
    sessionId: SESSION_ID,
  });
  const history = createHistory(conversation);

  return Object.freeze({
    sessionId: SESSION_ID,
    runIds: [RUN_A, RUN_B, RUN_C],
    conversation,
    history,
    expectedOldUnitIds: Object.freeze([
      `conversation:${String(turnIdFor(RUN_A))}`,
      `conversation:${String(turnIdFor(RUN_B))}`,
    ]),
    currentUnitId: `conversation:${String(turnIdFor(RUN_C))}`,
  });
}

export interface LongOpenTurnFixture {
  readonly conversation: ReturnType<typeof snapshot>;
  readonly history: ContextHistoryIndex;
  readonly closedProtocolUnitCount: number;
  readonly openProtocolUnitCount: number;
}

export function createLongOpenTurnFixture(): LongOpenTurnFixture {
  const runId = createRunId("run_0192f5b1-4d3a-7c2e-8a91-00000000d004");
  const sessionId = createSessionId("ses_0192f5b1-4d3a-7c2e-8a91-00000000d004");
  const messages: StoredAgentMessage[] = [
    userMessage({ runId, sessionId, sequence: 1, text: "Keep this current request." }),
  ];
  for (let index = 0; index < 100; index += 1) {
    const toolCallId = `call_deep_${String(index).padStart(3, "0")}`;
    messages.push(
      assistantMessage({
        runId,
        sessionId,
        sequence: index * 2 + 2,
        callId: `llm_deep_${index}`,
        toolCalls: [toolCallId],
      }),
      toolResultMessage({ runId, sessionId, sequence: index * 2 + 3, toolCallId }),
    );
  }
  messages.push(
    assistantMessage({
      runId,
      sessionId,
      sequence: 202,
      callId: "llm_deep_open",
      toolCalls: ["call_deep_open"],
    }),
  );
  const conversation = snapshot(
    [turn(messages, { runId, sessionId, status: "OPEN", openedAt: 1 })],
    { runId, sessionId },
  );
  const history = createHistory(conversation);
  const protocols = history.units.filter((unit) => unit.kind === "TOOL_PROTOCOL");

  return Object.freeze({
    conversation,
    history,
    closedProtocolUnitCount: protocols.filter((unit) => unit.status === "CLOSED").length,
    openProtocolUnitCount: protocols.filter((unit) => unit.status === "OPEN").length,
  });
}

export function createMultiRunPlannerPolicy(): ContextPolicy {
  return {
    targetRecentTailTokens: 100,
    minRecentTailTokens: 1,
    allowCurrentTurnPrefix: true,
  } as ContextPolicy;
}

export function createCompactionCandidate(input: { readonly estimatedInputTokensAfter: number }): {
  readonly coordinator: ReturnType<typeof createContextCompactionCoordinator>;
  readonly request: ContextCompactionRequest;
} {
  const runId = createRunId("run_0192f5b1-4d3a-7c2e-8a91-00000000d005");
  const sessionId = createSessionId("ses_0192f5b1-4d3a-7c2e-8a91-00000000d005");
  const range = createContextMessageRange({
    runId,
    conversationTurnId: conversationTurnId("cturn_deep_budget"),
    firstMessageId: agentMessageId("amsg_deep_budget_first"),
    lastMessageId: agentMessageId("amsg_deep_budget_last"),
    firstSequence: 1,
    lastSequence: 301,
  });
  const plan = {
    reason: "PROACTIVE_PRESSURE",
    cut: {
      kind: "TURN_BOUNDARY",
      firstKeptTurnId: conversationTurnId("cturn_deep_current"),
      firstKeptMessageId: agentMessageId("amsg_deep_current"),
      firstKeptSequence: 1,
    },
    sourceRange: range,
    selectedUnitIds: ["old-prefix"],
    retainedUnitIds: ["current-request"],
    estimatedTokensBefore: 930_000,
    selectedTokens: 900_000,
    retainedTokens: 30_000,
    targetRecentTailTokens: 20_000,
    minRecentTailTokens: 8_000,
  } satisfies ContextCompactionPlan;
  const semantic = {
    goal: "current goal",
    constraints: [],
    completedWork: ["old work"],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    criticalReferences: [],
    nextIntent: "continue",
  } as const;
  const summary = {
    semantic,
    modelRef: DEEP_COMPACTION_MODEL.ref,
    finishReason: "STOP" as const,
    summaryPromptVersion: 3,
    sourceDigest: "fixture-source-digest",
    semanticDigest: "fixture-semantic-digest",
  };
  const structuredCheckpoint = createStructuredCheckpoint({
    version: 1,
    goal: semantic.goal,
    constraints: [],
    completedWork: ["old work"],
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
    sourceRange: { from: 1, to: 301 },
  });
  const dependencies = {
    planner: { plan: () => plan },
    incrementalResolver: {
      resolve: () => ({
        newSourceMessages: [],
        cumulativeSourceRange: range,
        newSourceRange: range,
      }),
    },
    checkpointBudget: { resolve: () => ({ targetTokens: 8_192, maxTokens: 8_192 }) },
    gainEvaluator: {
      evaluate: () => ({
        selectedTokens: 900_000,
        estimatedCheckpointTokens: 8_192,
        estimatedFreedTokens: 891_808,
        gainRatio: 891_808 / 900_000,
      }),
    },
    summarizer: { summarize: async () => summary },
    summaryValidator: {
      validate: ({ result }: { readonly result: typeof summary }) => ({
        outcome: "ACCEPTED" as const,
        result,
      }),
    },
    factsProvider: {
      collect: async () => ({
        readFiles: [],
        changedFiles: [],
        recentErrors: [],
        verificationState: "UNKNOWN" as const,
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "UNKNOWN",
      }),
    },
    deterministicFallback: createDeterministicCheckpointBuilder(),
    enricher: { enrich: () => structuredCheckpoint },
    rehydrator: {} as never,
    tentativeRebuilder: {
      rebuild: async () => ({
        estimatedInputTokens: input.estimatedInputTokensAfter,
        retainedMessageIds: [],
      }),
    },
    commit: {
      commit: async ({
        checkpoint,
        events,
      }: Parameters<ContextCompactionDependencies["commit"]["commit"]>[0]) => ({
        checkpoint: { ...checkpoint, schemaVersion: 2 as const },
        events: events as never,
      }),
    },
    clock: { now: () => 1 as never },
    checkpointIdFactory: { create: () => "ctx_deep_budget" as never },
  } satisfies ContextCompactionDependencies;
  const request = {
    identity: { runId, sessionId, goal: "current goal" },
    conversation: snapshot([], { runId, sessionId }),
    history: { units: [], openUnits: [], closedUnits: [], estimatedTokens: 930_000 },
    policy: {
      effectiveInputLimitTokens: 1_028_096,
      outputReserveTokens: 16_384,
      safetyReserveTokens: 4_096,
      targetRecentTailTokens: 20_000,
      minRecentTailTokens: 8_000,
    } as ContextPolicy,
    model: DEEP_COMPACTION_MODEL,
    estimatedInputTokensBefore: 930_000,
    reason: "PROACTIVE_PRESSURE",
    signal: new AbortController().signal,
  } satisfies ContextCompactionRequest;

  return Object.freeze({
    coordinator: createContextCompactionCoordinator({
      dependencies,
      latest: { kind: "NONE" },
    }),
    request,
  });
}

function createHistory(conversation: ReturnType<typeof snapshot>): ContextHistoryIndex {
  return createContextHistoryIndexer().index({
    conversation,
    model: DEEP_COMPACTION_MODEL,
  });
}
