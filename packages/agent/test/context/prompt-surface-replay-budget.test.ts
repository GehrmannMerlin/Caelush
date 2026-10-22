import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextItemId,
  createContextMaterializer,
  createContextPlanner,
  createContextReceiptBuilder,
  createContextRehydrator,
  createContextRequestOverheadEstimator,
  createContextSourceItem,
  createContextSourceRegistryBuilder,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  decidePromptSurfaceCapacity,
  hashPromptSurfaceContent,
  promptSurfaceReplaySoftBudgetBytes,
  type ContextCheckpointRepositoryPort,
  type ContextSourceProvider,
  type ContextSourceResult,
  type ContextUsageStorePort,
  type PromptSurfaceSectionState,
  type StoredAgentMessage,
} from "@caelush/agent";
import { createRunId, createSessionId } from "@caelush/protocol";

import {
  assistantMessage,
  factory,
  snapshot,
  toolResultMessage,
  turn,
  turnIdFor,
} from "../messages/fixtures.js";
import {
  createPromptSurfaceMemoryStore,
  type PromptSurfaceMemoryStore,
} from "./support/prompt-surface-memory-store.js";

/**
 * What a Prompt Surface Epoch costs to replay, and when rotating it early is worth the rotation.
 *
 * ```text
 * hard bounds   records / decisions / epoch bytes   a stored epoch that cannot grow
 * soft budget   re-sent bytes per request          an epoch that is cheap to store, dear to replay
 * ```
 *
 * Rotating early is only correct when it actually makes the request smaller: a baseline that is not
 * smaller, or is itself over budget, turns a cheap decision into churn. The decision is pure, so the
 * cases below pin the arithmetic rather than a sequence of events.
 */

function sectionState(body: string): PromptSurfaceSectionState {
  const content = `<section authority="REFERENCE" stability="DYNAMIC" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="work-progress"><![CDATA[${body}]]></section>`;
  return Object.freeze({
    stateKey: `sha256:${hashPromptSurfaceContent("work-progress")}`,
    contentHash: hashPromptSurfaceContent(content),
    content,
  });
}

const SECTION: PromptSurfaceSectionState = sectionState("progress");

function record(kind: "BASELINE" | "DELTA", byteLength: number) {
  return { kind, byteLength };
}

describe("Prompt Surface replay budget", () => {
  it("rotates early only when the replay is over budget and the baseline is smaller", () => {
    const replay = Array.from({ length: 20 }, () => record("DELTA", 1_000));
    const candidate = record("DELTA", 1_000);

    const decision = decidePromptSurfaceCapacity({
      epoch: { records: replay, sectionStates: [SECTION] },
      candidate,
      targetSectionStates: [SECTION],
      replaySoftBudgetBytes: 4_000,
    });
    expect(decision.kind).toBe("ROLLOVER_SOFT");
    expect(decision).toMatchObject({ observed: 21_000, limit: 4_000 });
  });

  it("appends when the replay is inside the soft budget", () => {
    const decision = decidePromptSurfaceCapacity({
      epoch: { records: [record("DELTA", 100)], sectionStates: [SECTION] },
      candidate: record("DELTA", 100),
      targetSectionStates: [SECTION],
      replaySoftBudgetBytes: 4_000,
    });
    expect(decision.kind).toBe("APPEND");
  });

  it("appends when the baseline would not be smaller than the replay", () => {
    // A Section view whose baseline is larger than a short replay: rotating would cost more.
    const big: PromptSurfaceSectionState = sectionState("x".repeat(4_000));
    const decision = decidePromptSurfaceCapacity({
      epoch: { records: [record("DELTA", 10)], sectionStates: [big] },
      candidate: record("DELTA", 10),
      targetSectionStates: [big],
      replaySoftBudgetBytes: 40,
    });
    expect(decision.kind).toBe("APPEND");
  });

  it("appends when the baseline is itself over the soft budget instead of rotating in a loop", () => {
    const big: PromptSurfaceSectionState = sectionState("x".repeat(9_000));
    const decision = decidePromptSurfaceCapacity({
      epoch: {
        records: Array.from({ length: 20 }, () => record("DELTA", 1_000)),
        sectionStates: [big],
      },
      candidate: record("DELTA", 1_000),
      targetSectionStates: [big],
      // Over the replay, under the baseline: rotating would replace a large replay with a larger
      // baseline, which is not a bound and must defer to the pressure/compaction decision.
      replaySoftBudgetBytes: 6_000,
    });
    expect(decision.kind).toBe("APPEND");
  });

  it("still reports a hard capacity overflow before the soft budget", () => {
    const decision = decidePromptSurfaceCapacity({
      epoch: {
        records: Array.from({ length: 128 }, () => record("DELTA", 1)),
        sectionStates: [SECTION],
      },
      candidate: record("DELTA", 1),
      targetSectionStates: [SECTION],
      replaySoftBudgetBytes: 4_000,
    });
    expect(decision.kind).toBe("ROLLOVER_REQUIRED");
    expect(decision).toMatchObject({ dimension: "VISIBLE_RECORDS", observed: 129, limit: 128 });
  });

  it("derives the soft budget from the frozen policy, not from the window", () => {
    // Working set: a quarter of what the Run aims to carry.
    expect(
      promptSurfaceReplaySoftBudgetBytes({
        workingSetTargetTokens: 96_000,
        effectiveInputLimitTokens: 999_000,
      }),
    ).toBe(24_000 * 3);
    expect(
      promptSurfaceReplaySoftBudgetBytes({
        workingSetTargetTokens: 12_000,
        effectiveInputLimitTokens: 999_000,
      }),
    ).toBe(3_000 * 3);
    // Legacy: a tenth of the effective input budget, capped at the same constant.
    expect(promptSurfaceReplaySoftBudgetBytes({ effectiveInputLimitTokens: 100_000 })).toBe(
      10_000 * 3,
    );
    expect(promptSurfaceReplaySoftBudgetBytes({ effectiveInputLimitTokens: 4_000_000 })).toBe(
      24_000 * 3,
    );
  });
});

/* ------------------------------------------------------------------ engine-level rollover */

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "replay" },
  api: "test-api",
  limits: { contextWindowTokens: 1_000_000, maxOutputTokens: 128 },
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

const PROGRESS_SOURCE = "agent.replay-progress";

function progressProvider(): ContextSourceProvider {
  return Object.freeze({
    id: PROGRESS_SOURCE as never,
    async collect(input): Promise<ContextSourceResult> {
      // A Section that changes every Step: without it no DELTA is recorded and nothing is replayed.
      const text = `step ${String(input.turn.sequence)} ` + "progress ".repeat(60);
      return Object.freeze({
        providerId: PROGRESS_SOURCE as never,
        providerVersion: "replay-progress-v1",
        items: Object.freeze([
          createContextSourceItem({
            id: createContextItemId("agent.replay-progress:current"),
            type: "agent.replay-progress",
            source: {
              providerId: PROGRESS_SOURCE as never,
              sourceRef: "replay-progress:current",
              version: "replay-progress-v1",
            },
            scope: "RUN",
            retention: "COMPRESSIBLE",
            priorityClass: "NORMAL",
            tokenEstimate: 60,
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: "replay fixture",
            payload: { kind: "TEXT", text },
          }),
        ]),
        diagnostics: Object.freeze([]),
      });
    },
  });
}

function engine(store: PromptSurfaceMemoryStore, workingSetTargetTokens: number) {
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
    .register({
      id: PROGRESS_SOURCE as never,
      priority: 10,
      criticality: "OPTIONAL",
      provider: progressProvider(),
    })
    .build();
  return createV2ContextEngine({
    promptSurfaceStore: store,
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
    } satisfies ContextCheckpointRepositoryPort,
    authorityProvider: {
      async snapshot() {
        return { goal: "current goal", verificationState: "NOT_RUN" };
      },
    },
    usageStore: {
      async upsert() {},
      async getByRun() {
        return undefined;
      },
    } satisfies ContextUsageStorePort,
    policy: { outputReserveTokens: 128, safetyReserveTokens: 0 },
    // A working set is what selects the bounded replay rule, so the fixture pins one.
    workingSet: {
      targetTokens: workingSetTargetTokens,
      triggerRatio: 0.75,
      postCompactionRatio: 0.5,
      allowCurrentTurnPrefix: true,
      cooldownTurns: 5,
    },
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
    receiptBuilder: createContextReceiptBuilder({ now: () => 1_000 as never, tokenEstimator }),
    tokenEstimator,
    clock: { now: () => 1_000 as never },
  });
}

describe("Prompt Surface early rollover", () => {
  it("rotates an epoch whose replay outgrew the working set budget and reports REPLAY_TOKENS", async () => {
    const runId = createRunId();
    const conversationTurnId = turnIdFor(runId);
    const messageFactory = factory(64);
    const messages: StoredAgentMessage[] = [
      assistantMessage({
        messageFactory,
        runId,
        turnId: conversationTurnId,
        sequence: 1,
        text: "goal accepted",
      }),
    ];
    for (let step = 1; step <= 12; step += 1) {
      messages.push(
        assistantMessage({
          messageFactory,
          runId,
          turnId: conversationTurnId,
          sequence: step * 2,
          toolCalls: [`call_${String(step)}`],
          callId: `call_${String(step)}`,
        }),
        toolResultMessage({
          messageFactory,
          runId,
          turnId: conversationTurnId,
          sequence: step * 2 + 1,
          toolCallId: `call_${String(step)}`,
          toolName: "tool_0",
          projectedContent: `step ${String(step)} output`,
        }),
      );
    }
    const store = createPromptSurfaceMemoryStore();
    const prepareAt = (step: number, stepSequence: number) =>
      engine(store, 7_000).prepare({
        identity: { runId, sessionId: createSessionId(), goal: "current goal" },
        turn: { stepId: `step:${String(stepSequence)}` as never, sequence: stepSequence },
        conversation: snapshot(
          [
            turn(messages.slice(0, (step - 1) * 2 + 1), {
              runId,
              status: "OPEN",
            }),
          ],
          { runId },
        ),
        input: { kind: "CONTINUATION" as const, reason: "STEERING" as const },
        model: MODEL,
        tools: [],
        mode: "NORMAL" as const,
        signal: new AbortController().signal,
      });

    await prepareAt(1, 1);
    const first = await store.getCurrent(runId);
    expect(first?.resetReason).toBe("INITIAL");

    // A working-set target of 7000 tokens puts the soft budget at 1750 tokens (5250 UTF-8 bytes). The
    // first two records are appended — one record has nothing to fold — and the third pushes the replay
    // (a ~3.7 KiB baseline plus two ~1.2 KiB deltas) past the budget while the baseline itself is
    // smaller and inside it, so that Step rotates instead of replaying.
    await prepareAt(2, 2);
    expect((await store.getCurrent(runId))?.epochId).toBe(first?.epochId);
    await prepareAt(3, 3);
    const second = await store.getCurrent(runId);
    expect(second?.resetReason).toBe("CAPACITY_ROLLOVER");
    expect(second?.epochId).not.toBe(first?.epochId);
    expect(second?.createdStepSequence).toBe(3);

    const surface = second === undefined ? undefined : await store.readEpoch(runId, second.epochId);
    expect(surface?.records?.map((entry) => entry.kind)).toEqual(["BASELINE"]);

    const prepared = await prepareAt(4, 4);
    const preflight = prepared.report.preflight;
    expect(preflight?.replayTokens).toBeGreaterThan(0);
    expect(preflight?.compacted).toBe(false);
    expect(preflight?.matchesSentProjection).toBe(true);
  });
});
