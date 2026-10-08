import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ModelUsage } from "@caelush/ai";
import {
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  type ContextSummarizationInput,
} from "@caelush/agent";
import { createRunId, createStepId, createTimestampMs } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createBudgetedContextSummarizer } from "../src/context/context-compaction-composition.js";
import {
  composeDaemon,
  createProviderInvocationAccountingObserver,
  type DaemonComposition,
} from "../src/daemon-composition.js";
import {
  FIXTURE_API,
  fixtureBinding,
  fixtureDescriptor,
  fixtureModelSource,
} from "./support/ai-fixture.js";
import { makeRun, makeSession, makeStep } from "../../../packages/storage/test/support/fixtures.js";

const USAGES: readonly ModelUsage[] = [
  usage(100, 0, 100),
  usage(120, 80, 40),
  usage(140, 100, 40),
  usage(50, 20, 30),
  usage(60, 30, 30),
];

const SUMMARY = JSON.stringify({
  goal: "Continue the fixture task.",
  constraints: [],
  completedWork: [],
  inProgress: [],
  blocked: [],
  importantDiscoveries: [],
  keyDecisions: [],
  criticalReferences: [],
  nextIntent: "Continue safely.",
});

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
});

function usage(
  inputTokens: number,
  cachedInputTokens: number,
  cacheMissInputTokens: number,
): ModelUsage {
  return {
    inputTokens,
    outputTokens: 10,
    totalTokens: inputTokens + 10,
    cachedInputTokens,
    cacheMissInputTokens,
    cacheWriteInputTokens: 5,
    reasoningTokens: 2,
  };
}

class DeterministicUsageAdapter implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    const callIndex = this.calls++;
    const actualUsage = USAGES[callIndex];
    if (actualUsage === undefined)
      throw new Error("The fake Usage trajectory exceeded five calls.");
    const lastMessage = input.request.messages.at(-1);
    const isCompaction =
      lastMessage?.role === "user" &&
      typeof lastMessage.content === "string" &&
      lastMessage.content.includes("SemanticCheckpointDraft only");
    yield { type: "usage", payload: actualUsage };
    yield {
      type: "text.delta",
      payload: { text: isCompaction ? SUMMARY : `fixture-answer-${callIndex + 1}` },
    };
    yield {
      type: "adapter.finish",
      payload: { finishReason: "STOP", finalUsage: actualUsage },
    };
  }
}

describe("C4 fake Provider Usage trajectory", () => {
  it("persists five production Gateway invocations once per purpose and restores V2 metrics after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-c4-usage-trajectory-"));
    const databasePath = join(directory, "caelush.db");
    storage = await openCaelushStorage({ path: databasePath });
    const session = makeSession();
    const run = makeRun(session.id, {
      goal: "Account for deterministic Provider Usage.",
      model: { provider: "fixture", model: "fixture-model" },
      createdAt: createTimestampMs(10),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);

    let tick = 100;
    const clock = { now: () => createTimestampMs(tick++) };
    const adapter = new DeterministicUsageAdapter();
    composition = await composeDaemon({
      storage,
      clock,
      modelSources: [fixtureModelSource()],
      providerBindings: [fixtureBinding()],
      adapterOverrides: [adapter],
    });

    await storage.contextUsage.upsert({
      runId: run.id,
      modelRef: run.model,
      contextWindowTokens: 1_000,
      effectiveInputLimitTokens: 800,
      estimatedInputTokens: 100,
      remainingTokens: 700,
      pressureState: "NORMAL",
      compactionCount: 0,
      lastRecoveryStages: [],
      breakdown: [],
      lastBuildStatus: "SUCCESS",
      promptSurface: {
        epochId: "fixture-prompt-surface-epoch",
        prefixFingerprint: `sha256:${"a".repeat(64)}`,
        stableHeadTokens: 100,
        snapshotTokens: 0,
        expectedReusablePrefixTokens: 100,
        resetReason: "INITIAL",
      },
      updatedAt: createTimestampMs(20),
    });

    const identity = composition.resolveTurnIdentity(run);
    for (const sequence of [1, 2, 3]) {
      const step = makeStep(run.id, { id: createStepId(), sequence });
      await storage.budget.admitLLM({
        run,
        step,
        admission: { estimatedInputTokens: 100, configuredMaxOutputTokens: 32 },
      });
      const result = await composition.modelTurnExecutor.execute({
        identity,
        turn: { stepId: step.id, sequence },
        request: request(`main-${sequence}`),
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe("COMPLETED");
      if (result.kind !== "COMPLETED")
        throw new Error("Main Provider invocation did not complete.");
      await storage.budget.settleLLM({
        runId: run.id,
        stepId: step.id,
        providerCallId: result.result.callId,
        usage: result.result.usage,
        settledAt: clock.now(),
      });
    }

    const verificationOwner = "c4-verification-owner";
    await storage.budget.admitVerificationLLM({
      run,
      ownerId: verificationOwner,
      admission: { estimatedInputTokens: 50, configuredMaxOutputTokens: 32 },
    });
    const verification = await composition.verificationModelTurns.execute({
      identity,
      request: request("verification"),
      signal: new AbortController().signal,
    });
    await storage.budget.settleVerificationLLM({
      runId: run.id,
      ownerId: verificationOwner,
      providerCallId: verification.callId,
      usage: verification.usage,
      settledAt: clock.now(),
    });

    const sourceIds = createAgentMessageIdFactory();
    const sourceMessageId = sourceIds.create();
    const turnId = createDeterministicConversationTurnIdFactory().forRun(run.id);
    const summaryInput: ContextSummarizationInput = {
      purpose: "COMPACTION",
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefixFingerprint: "b".repeat(64),
      replayPrefix: {
        modelRef: fixtureDescriptor().ref,
        api: FIXTURE_API,
        surfaceFingerprint: "b".repeat(64),
        messages: [
          { role: "system", content: "Stable fixture prefix." },
          { role: "user", content: "Previously selected history." },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a workspace file.",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
      identity,
      reason: "PROACTIVE_PRESSURE",
      sourceMessages: [],
      sourceRange: {
        runId: run.id,
        conversationTurnId: turnId,
        firstMessageId: sourceMessageId,
        lastMessageId: sourceMessageId,
        firstSequence: 1,
        lastSequence: 1,
      },
      cut: {
        kind: "TURN_BOUNDARY",
        firstKeptTurnId: turnId,
        firstKeptMessageId: sourceMessageId,
        firstKeptSequence: 1,
      },
      targetTokens: 32,
      model: fixtureDescriptor(),
    };
    const summarizer = createBudgetedContextSummarizer({
      gateway: composition.ai.gateway,
      budget: storage.budget,
      run,
      clock,
      invocationObserver: createProviderInvocationAccountingObserver({
        storage,
        runId: run.id,
        purpose: "CONTEXT_COMPACTION",
        clock,
      }),
    });
    await summarizer.summarize(summaryInput, { signal: new AbortController().signal });

    expect(adapter.calls).toBe(5);
    const firstProjection = await composition.contextUsage.getContextUsage(String(run.id));
    expect(firstProjection?.promptCache?.metricsV2).toMatchObject({
      fullRun: {
        mainAgent: { requestCount: 3, hitTokens: 180, accountedTokens: 360, hitRate: 0.5 },
        allPurposes: {
          requestCount: 5,
          hitTokens: 230,
          accountedTokens: 470,
          hitRate: 230 / 470,
        },
      },
      warm: {
        mainAgent: {
          requestCount: 2,
          hitTokens: 180,
          accountedTokens: 260,
          hitRate: 180 / 260,
        },
      },
      rolling: { windowSize: 10, allPurposes: { requestCount: 5 } },
      latestRequest: {
        purpose: "CONTEXT_COMPACTION",
        hitTokens: 30,
        missTokens: 30,
        cacheUsageReported: true,
      },
      usageCoverage: {
        observedRequestCount: 5,
        completeCacheUsageCount: 5,
        incompleteOrUnknownCount: 0,
        providerUsageUnreportedCount: 0,
        providerUsageWithoutCacheBreakdownCount: 0,
        failedOrCancelledWithoutUsageCount: 0,
        inProgressInvocationCount: 0,
        missingInvocationRecordCount: 0,
        legacyWithoutCacheBreakdownCount: 0,
        unidentifiedLegacySampleCount: 0,
        coverageRate: 1,
        status: "REPORTED",
      },
    });
    expect(
      firstProjection?.promptCache?.purposes.map(({ purpose, requestCount }) => [
        purpose,
        requestCount,
      ]),
    ).toEqual([
      ["MAIN_AGENT", 3],
      ["VERIFICATION_LLM", 1],
      ["CONTEXT_COMPACTION", 1],
    ]);

    const firstRecords = await storage.providerInvocationUsage.listByRun(run.id);
    expect(firstRecords).toHaveLength(5);
    expect(new Set(firstRecords.map(({ callId }) => callId)).size).toBe(5);
    expect(firstRecords.map(({ purpose }) => purpose)).toEqual([
      "MAIN_AGENT",
      "MAIN_AGENT",
      "MAIN_AGENT",
      "VERIFICATION_LLM",
      "CONTEXT_COMPACTION",
    ]);
    const budgetEntries = await storage.budgetLedger.listByRun(run.id);
    expect(budgetEntries.filter((entry) => entry.state === "SETTLED")).toHaveLength(5);
    expect(budgetEntries.every((entry) => entry.providerCallId !== undefined)).toBe(true);

    await composition.dispose();
    composition = undefined;
    await storage.close();
    storage = await openCaelushStorage({ path: databasePath });
    composition = await composeDaemon({
      storage,
      clock,
      modelSources: [fixtureModelSource()],
      providerBindings: [fixtureBinding()],
      adapterOverrides: [adapter],
    });

    const restored = await composition.contextUsage.getContextUsage(String(run.id));
    expect(restored?.promptCache?.metricsV2).toEqual(firstProjection?.promptCache?.metricsV2);
    expect(await storage.providerInvocationUsage.listByRun(run.id)).toHaveLength(5);
    expect(adapter.calls).toBe(5);
  });
});

function request(prompt: string) {
  return {
    model: { provider: "fixture", model: "fixture-model" },
    messages: [{ role: "user" as const, content: prompt }],
  };
}
