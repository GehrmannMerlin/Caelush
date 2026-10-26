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
  type ContextCheckpointRepositoryPort,
  type ContextSourceProvider,
  type ContextSourceResult,
  type ContextUsageSnapshot,
  type ContextUsageStorePort,
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
 * What the pressure preflight measures must be what the provider receives.
 *
 * ```text
 * durable surface (N records) + this Step's candidate = the projection
 *        ↓                                                    ↓
 *  compaction decision                                   provider request
 * ```
 *
 * The production defect was that the left path folded the whole history into one synthetic baseline
 * while the right path replayed every delta. The estimate was honest about a request that was never
 * sent, so compaction never fired for the request that was.
 *
 * The durable Surface here is not seeded by hand: it is accumulated by preparing real Steps against
 * a real engine, because a hand-written epoch whose fingerprints do not match this Step's identity is
 * discarded as `TOOL_SCHEMA_CHANGED` and proves nothing about replay.
 */

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "parity" },
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

/** A source whose content changes every Step, so each Step has a real Section delta to record. */
const WORK_PROGRESS_SOURCE = "agent.work-progress";

function workProgressProvider(): ContextSourceProvider {
  return Object.freeze({
    id: WORK_PROGRESS_SOURCE as never,
    async collect(input): Promise<ContextSourceResult> {
      const text = `Settled through step ${String(input.turn.sequence)} of the current Run.`;
      return Object.freeze({
        providerId: WORK_PROGRESS_SOURCE as never,
        providerVersion: "work-progress-v1",
        items: Object.freeze([
          createContextSourceItem({
            id: createContextItemId("agent.work-progress:current"),
            type: "agent.work-progress",
            source: {
              providerId: WORK_PROGRESS_SOURCE as never,
              sourceRef: "work-progress:current",
              version: "work-progress-v1",
            },
            scope: "RUN",
            retention: "COMPRESSIBLE",
            priorityClass: "NORMAL",
            tokenEstimate: Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3)),
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: "current Step progress",
            payload: { kind: "TEXT", text },
          }),
        ]),
        diagnostics: Object.freeze([]),
      });
    },
  });
}

function checkpointRepository(): ContextCheckpointRepositoryPort {
  const none = undefined;
  return {
    async create() {
      throw new Error("not used");
    },
    async getLatestByRun() {
      return none;
    },
    async getById() {
      return none;
    },
    async listByRun() {
      return [];
    },
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

function createEngine(store: PromptSurfaceMemoryStore, counts?: { collect: number }) {
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
      provider: {
        id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
        async collect(input) {
          if (counts !== undefined) counts.collect += 1;
          return createCorePolicyContextSourceProvider({ text: "Current task policy." }).collect(
            input,
          );
        },
      },
    })
    .register({
      id: WORK_PROGRESS_SOURCE as never,
      priority: 10,
      criticality: "OPTIONAL",
      provider: workProgressProvider(),
    })
    .build();
  return createV2ContextEngine({
    promptSurfaceStore: store,
    sourceRegistry: registry,
    checkpointRepository: checkpointRepository(),
    authorityProvider: {
      async snapshot() {
        return { goal: "current goal", verificationState: "NOT_RUN" };
      },
    },
    usageStore: usageStore(),
    policy: { outputReserveTokens: 128, safetyReserveTokens: 0 },
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
    receiptBuilder: createContextReceiptBuilder({
      now: () => 1_000 as never,
      tokenEstimator,
    }),
    tokenEstimator,
    clock: { now: () => 1_000 as never },
  });
}

interface Scenario {
  readonly runId: ReturnType<typeof createRunId>;
  readonly store: PromptSurfaceMemoryStore;
  /** `messages[0]` is the Run's first model turn; each Step then contributes a call and its result. */
  readonly messages: readonly StoredAgentMessage[];
}

function scenario(steps: number): Scenario {
  const runId = createRunId();
  const conversationTurnId = turnIdFor(runId);
  // Each Scenario mints its own identity sequence: the shared fixture factory is bounded at 512 ids.
  const messageFactory = factory(steps * 2 + 16);
  const messages: StoredAgentMessage[] = [
    assistantMessage({
      messageFactory,
      runId,
      turnId: conversationTurnId,
      sequence: 1,
      text: "goal accepted",
    }),
  ];
  for (let step = 1; step <= steps; step += 1) {
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
  return { runId, store: createPromptSurfaceMemoryStore(), messages };
}

/** The conversation as it stands at the start of `step`: every earlier Step has settled. */
function conversationAt(seeded: Scenario, step: number) {
  const settled = seeded.messages.slice(0, (step - 1) * 2 + 1);
  return snapshot([turn(settled, { runId: seeded.runId, status: "OPEN" })], {
    runId: seeded.runId,
  });
}

function prepareAt(
  seeded: Scenario,
  store: PromptSurfaceMemoryStore,
  step: number,
  model: ModelDescriptor = MODEL,
  counts?: { collect: number },
) {
  return createEngine(store, counts).prepare({
    identity: { runId: seeded.runId, sessionId: createSessionId(), goal: "current goal" },
    turn: { stepId: `step:${String(step)}` as never, sequence: step },
    conversation: conversationAt(seeded, step),
    input: { kind: "CONTINUATION" as const, reason: "STEERING" as const },
    model,
    tools: [],
    mode: "NORMAL" as const,
    signal: new AbortController().signal,
  });
}

/** Prepare Steps 1..`steps` so the durable Surface holds one record per settled Step. */
async function settle(seeded: Scenario, steps: number): Promise<void> {
  for (let step = 1; step <= steps; step += 1) {
    await prepareAt(seeded, seeded.store, step);
  }
}

function surfaceMessages(messages: readonly { readonly content: unknown }[]): number {
  return messages.filter(
    (message) =>
      typeof message.content === "string" && message.content.startsWith("<runtime_context_"),
  ).length;
}

describe("Context pressure preflight parity", () => {
  it("lets the production message projector price cut-point history instead of durable rows", () => {
    const seeded = scenario(2);
    const conversation = conversationAt(seeded, 2);
    const index = createContextHistoryIndexer({
      estimateMessageTokens: () => 17,
    }).index({ conversation, model: MODEL });

    expect(index.estimatedTokens).toBe(3 * 17);
    expect(index.units.find((unit) => unit.kind === "CONVERSATION_TURN")?.tokenEstimate).toBe(
      3 * 17,
    );
  });

  it("measures the projection it sends, not a folded equivalent", async () => {
    const settledSteps = 6;
    const seeded = scenario(settledSteps + 1);
    await settle(seeded, settledSteps);

    const counts = { collect: 0 };
    const prepared = await prepareAt(seeded, seeded.store, settledSteps + 1, MODEL, counts);

    const preflight = prepared.report.preflight;
    expect(preflight).toBeDefined();
    expect(preflight!.compacted).toBe(false);
    // The estimate and the request are the same projection, by content.
    expect(preflight!.matchesSentProjection).toBe(true);
    expect(preflight!.projectionFingerprint).toBe(preflight!.sentFingerprint);
    expect(preflight!.estimatedInputTokens).toBe(prepared.report.estimatedInputTokens);
    // A folded baseline is one message; the replayed Surface is one message per durable record plus
    // this Step's candidate. The request carries the replay.
    expect(surfaceMessages(prepared.messages)).toBe(settledSteps + 1);
    // One collection per preparation, never one per estimate.
    expect(counts.collect).toBe(1);
  });

  it("counts request overhead exactly once and never twice", async () => {
    const seeded = scenario(2);
    const prepared = await prepareAt(seeded, seeded.store, 1);
    const report = prepared.report;

    expect(
      report.effectiveInputLimitTokens +
        report.requestOverheadTokens +
        prepared.requestBudget.outputReserveTokens +
        prepared.requestBudget.safetyReserveTokens,
    ).toBe(MODEL.limits.contextWindowTokens);
    expect(report.remainingTokens).toBe(
      report.effectiveInputLimitTokens - report.estimatedInputTokens,
    );
    // The overhead is a property of the request, not of the message list: it is not inside the
    // materialized estimate, so adding it to the effective limit and to the estimate cannot happen.
    expect(report.pressure).toBe("NORMAL");
  });

  it("writes nothing when the projected request does not fit", async () => {
    const settledSteps = 4;
    const seeded = scenario(settledSteps + 1);
    await settle(seeded, settledSteps);
    const replayed = await prepareAt(seeded, seeded.store, settledSteps + 1);

    // The same Step of a Run with no durable epoch renders one baseline instead of the replay.
    const foldedScenario = scenario(settledSteps + 1);
    const folded = await prepareAt(foldedScenario, foldedScenario.store, settledSteps + 1);
    expect(folded.report.estimatedInputTokens).toBeLessThan(replayed.report.estimatedInputTokens);

    // A window the folded projection fits in and the replayed one does not.
    const window =
      folded.report.estimatedInputTokens +
      1 +
      replayed.report.requestOverheadTokens +
      replayed.requestBudget.outputReserveTokens +
      replayed.requestBudget.safetyReserveTokens;
    const tightModel: ModelDescriptor = {
      ...MODEL,
      limits: { contextWindowTokens: window, maxOutputTokens: 128 },
    };

    const writes: string[] = [];
    const store: PromptSurfaceMemoryStore = {
      ...seeded.store,
      async createEpoch(epoch) {
        writes.push("createEpoch");
        return seeded.store.createEpoch(epoch);
      },
      async appendRecord(record, identity, ordinal) {
        writes.push("appendRecord");
        return seeded.store.appendRecord(record, identity, ordinal);
      },
      async appendSnapshot(snapshotValue, identity) {
        writes.push("appendSnapshot");
        return seeded.store.appendSnapshot(snapshotValue, identity);
      },
      async rolloverEpoch(command) {
        writes.push("rolloverEpoch");
        return seeded.store.rolloverEpoch(command);
      },
    };

    await expect(prepareAt(seeded, store, settledSteps + 1, tightModel)).rejects.toThrow();
    // The preflight read the durable epoch and projected its own decision; the refusal came before
    // any durable decision: no epoch, no record, no snapshot.
    expect(writes).toEqual([]);
  });

  it("produces byte-identical messages when the same Step is prepared twice", async () => {
    const seeded = scenario(4);
    await settle(seeded, 2);
    const first = await prepareAt(seeded, seeded.store, 3);
    const retry = await prepareAt(seeded, seeded.store, 3);

    expect(retry.messages).toEqual(first.messages);
    expect(retry.report.estimatedInputTokens).toBe(first.report.estimatedInputTokens);
    expect(retry.report.preflight?.matchesSentProjection).toBe(true);
  });
});
