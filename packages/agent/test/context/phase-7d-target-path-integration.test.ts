import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  collectContextSources,
  createContextCompactionPlanner,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextMaterializer,
  createContextPolicy,
  createContextRehydrator,
  createContextSourceRegistryBuilder,
  createConversationContextSourceProvider,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createContextSummarizationRunner,
  createStructuredCheckpoint,
  planContext,
  type ContextSummarizerPort,
} from "@caelush/agent";
import { createRunId, createSessionId } from "@caelush/protocol";

import {
  OTHER_RUN_ID,
  assistantMessage,
  snapshot,
  turn,
  userMessage,
} from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7d-integration" },
  api: "test-api",
  limits: { contextWindowTokens: 500, maxOutputTokens: 64 },
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

describe("Phase 7D target path integration", () => {
  it("closes Providers → history → planner → compaction → checkpoint → rehydration → document → AIMessage[]", async () => {
    const oldUser = userMessage({ runId: OTHER_RUN_ID, sequence: 1, text: "old request" });
    const oldAssistant = assistantMessage({
      runId: OTHER_RUN_ID,
      sequence: 2,
      text: "old answer",
    });
    const currentUser = userMessage({ sequence: 1, text: "current request" });
    const conversation = snapshot([
      turn([oldUser, oldAssistant], { runId: OTHER_RUN_ID, status: "CLOSED", openedAt: 1 }),
      turn([currentUser], { status: "OPEN", openedAt: 2 }),
    ]);
    const policy = createContextPolicy({
      model: MODEL,
      requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
      options: {
        outputReserveTokens: 32,
        safetyReserveTokens: 0,
        targetRecentTailRatio: 0.1,
        minRecentTailRatio: 0.05,
        targetRecentTailTokensCap: 60,
        minRecentTailTokensCap: 20,
      },
    });
    const sourceRegistry = createContextSourceRegistryBuilder()
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.conversation,
        priority: 0,
        criticality: "REQUIRED",
        provider: createConversationContextSourceProvider(),
      })
      .build();
    const sourceInput = {
      identity: { runId: createRunId(), sessionId: createSessionId(), goal: "integration" },
      turn: { stepId: "step_7d" as never, sequence: 1 },
      conversation,
      input: { kind: "USER_INPUT" as const, userMessageId: currentUser.message.id },
      model: MODEL,
      mode: "NORMAL" as const,
      policy,
      signal: new AbortController().signal,
    };
    const sourceResults = await collectContextSources(sourceRegistry, sourceInput);
    const sourceItems = sourceResults.flatMap((result) => result.items);
    const history = createContextHistoryIndexer().index({ conversation, model: MODEL });
    const contextPlan = planContext({
      items: sourceItems,
      policy,
      history,
      currentTurnId: conversation.currentTurnId,
    });
    const compactionPlan = createContextCompactionPlanner().plan({
      history,
      policy,
      reason: "PROACTIVE_PRESSURE",
    });
    expect(compactionPlan?.selectedUnitIds.length).toBeGreaterThan(0);

    const sourceMessages = conversation.turns
      .flatMap((conversationTurn) => conversationTurn.messages)
      .filter(
        (stored) =>
          compactionPlan!.sourceRange.firstSequence <= stored.sequence &&
          stored.sequence <= compactionPlan!.sourceRange.lastSequence &&
          stored.message.conversationTurnId === compactionPlan!.sourceRange.conversationTurnId,
      );
    const summarizer: ContextSummarizerPort = {
      async summarize(input) {
        return {
          checkpoint: createStructuredCheckpoint({
            version: 1,
            goal: input.identity.goal,
            constraints: [],
            completedWork: ["old request"],
            inProgress: [],
            blocked: [],
            importantDiscoveries: [],
            keyDecisions: [],
            changedFiles: [],
            readFiles: [],
            recentErrors: [],
            verificationState: "not-run",
            activeProcesses: [],
            pendingApprovals: [],
            resourceGovernance: "bounded",
            criticalReferences: [],
            nextIntent: "continue",
            sourceRange: {
              from: input.sourceRange.firstSequence,
              to: input.sourceRange.lastSequence,
            },
          }),
          modelRef: input.model.ref,
          summaryPromptVersion: 1,
          sourceDigest: "ignored",
          checkpointDigest: "ignored",
        };
      },
    };
    const summary = await createContextSummarizationRunner({ summarizer }).summarize(
      {
        identity: sourceInput.identity,
        reason: "PROACTIVE_PRESSURE",
        sourceMessages,
        sourceRange: compactionPlan!.sourceRange,
        authorities: { goal: "current request", verificationState: "not-run" },
        targetTokens: policy.targetRecentTailTokens,
        model: MODEL,
      },
      { signal: sourceInput.signal },
    );
    expect(summary.degraded).toBe(false);

    const rehydrated = await createContextRehydrator().rehydrate({
      checkpoint: summary.result.checkpoint,
      authorities: { goal: "current request", changedFiles: [], verificationState: "not-run" },
    });
    const document = createContextDocumentBuilder().build({
      plan: contextPlan,
      rehydrated,
    });
    const messages = await createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
    }).materialize({
      prepared: {
        conversationMessages: conversation.turns.flatMap(
          (conversationTurn) => conversationTurn.messages,
        ),
        document,
        plan: contextPlan,
        receipt: {},
        observationPolicy: policy.observationPolicy,
        contextFingerprint: "sha256:integration" as never,
      },
      model: MODEL,
      signal: new AbortController().signal,
    });

    expect(sourceResults).toHaveLength(1);
    expect(document.sections.length).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(
      messages.some((message) => message.role === "user" && message.content === "current request"),
    ).toBe(true);
  });
});
