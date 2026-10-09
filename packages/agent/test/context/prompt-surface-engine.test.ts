import type { AIModelSettings, AIToolSpec, ModelDescriptor } from "@caelush/ai";
import { describe, expect, it } from "vitest";

import {
  AGENT_CONTEXT_SOURCE_IDS,
  PromptSurfaceIntegrityError,
  createPromptSurfaceEpoch,
  createPromptSurfaceSnapshot,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextItemId,
  createContextMaterializer,
  createContextPlanner,
  createContextReceiptBuilder,
  createContextRehydrator,
  createContextSourceItem,
  createContextSourceRegistryBuilder,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  latestCompletePromptSurfaceAnchor,
  createV2ContextEngine,
  type ContextUsageSnapshot,
  type StoredAgentMessage,
  type V2ContextEngineOptions,
} from "@caelush/agent";
import { createRunId, createSessionId, type TimestampMs } from "@caelush/protocol";

import { assistantMessage, snapshot, turn, userMessage } from "../messages/fixtures.js";
import {
  createPromptSurfaceMemoryStore,
  type PromptSurfaceMemoryStore,
} from "./support/prompt-surface-memory-store.js";
import {
  promptProjectionPreservesUncoveredModelMessages,
  promptSurfaceStableHeadFingerprint,
  promptSurfaceReplayIdentityMatches,
} from "../../src/context/engine/context-engine.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "surface-a" },
  api: "fixture-chat",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 512 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "SUPPORTED",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "SUPPORTED",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const TOOL_A: AIToolSpec = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

const TOOL_B: AIToolSpec = {
  name: "list_directory",
  description: "List a directory.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

interface FixtureState {
  dynamicText: string | undefined;
  dynamicSourceFails: boolean;
  readonly usage: ContextUsageSnapshot[];
  now: number;
  epochId: number;
}

function fixture(): {
  readonly runId: ReturnType<typeof createRunId>;
  readonly sessionId: ReturnType<typeof createSessionId>;
  readonly store: PromptSurfaceMemoryStore;
  readonly state: FixtureState;
  engine(input?: {
    readonly settings?: AIModelSettings;
    readonly baseSystemPrompt?: string;
  }): ReturnType<typeof createV2ContextEngine>;
} {
  const runId = createRunId();
  const sessionId = createSessionId();
  const store = createPromptSurfaceMemoryStore();
  const state: FixtureState = {
    dynamicText: "workspace state: clean",
    dynamicSourceFails: false,
    usage: [],
    now: 100,
    epochId: 0,
  };
  const tokenEstimator = createUtf8HeuristicTokenEstimator();

  return {
    runId,
    sessionId,
    store,
    state,
    engine(input = {}) {
      const baseSystemPrompt = input.baseSystemPrompt ?? "Stable fixture policy.";
      const dynamicSourceId = AGENT_CONTEXT_SOURCE_IDS.branchContext;
      const sourceRegistry = createContextSourceRegistryBuilder()
        .register({
          id: AGENT_CONTEXT_SOURCE_IDS.conversation,
          priority: 10,
          criticality: "REQUIRED",
          provider: createConversationContextSourceProvider(),
        })
        .register({
          id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
          priority: 0,
          criticality: "REQUIRED",
          provider: createCorePolicyContextSourceProvider({ text: baseSystemPrompt }),
        })
        .register({
          id: dynamicSourceId,
          priority: 40,
          criticality: "OPTIONAL",
          provider: {
            id: dynamicSourceId,
            async collect() {
              if (state.dynamicSourceFails) throw new Error("optional context source failed");
              const text = state.dynamicText;
              return {
                providerId: dynamicSourceId,
                providerVersion: "fixture-v1",
                items:
                  text === undefined
                    ? []
                    : [
                        createContextSourceItem({
                          id: createContextItemId("fixture:runtime-state"),
                          type: "coding.runtime_fact",
                          source: {
                            providerId: dynamicSourceId,
                            sourceRef: "fixture:runtime-state",
                            version: "fixture-v1",
                          },
                          scope: "RUN",
                          retention: "EPHEMERAL",
                          priorityClass: "HIGH",
                          tokenEstimate: 20,
                          cacheStability: "DYNAMIC",
                          freshness: "CURRENT",
                          sensitivity: "INTERNAL",
                          whyLoaded: "fixture runtime state",
                          payload: { kind: "TEXT", text },
                        }),
                      ],
                diagnostics: [],
              };
            },
          },
        })
        .build();

      const options: V2ContextEngineOptions = {
        promptSurfaceStore: store,
        sourceRegistry,
        checkpointRepository: {
          async create() {
            throw new Error("checkpoint creation is not expected in this fixture");
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
            return {
              goal: "",
              changedFiles: [],
              pendingApprovals: [],
              activeProcesses: [],
              verificationState: "",
              resourceGovernance: "",
              projectFacts: [],
            };
          },
        },
        usageStore: {
          async upsert(value) {
            state.usage.push(value);
          },
          async getByRun() {
            return state.usage.at(-1);
          },
        },
        ...(input.settings === undefined ? {} : { modelSettings: input.settings }),
        promptSurfaceEpochIdFactory: {
          create() {
            state.epochId += 1;
            return `fixture-epoch-${String(state.epochId)}`;
          },
        },
        clock: {
          now() {
            state.now += 1;
            return state.now as TimestampMs;
          },
        },
        policy: { outputReserveTokens: 512, safetyReserveTokens: 0 },
        historyIndexer: createContextHistoryIndexer(),
        planner: createContextPlanner(),
        rehydrator: createContextRehydrator(),
        documentBuilder: createContextDocumentBuilder(),
        materializer: createContextMaterializer({
          projectors: createStandardAgentMessageProjectorRegistry(),
          tokenEstimator,
        }),
        receiptBuilder: createContextReceiptBuilder({
          now: () => state.now as TimestampMs,
          tokenEstimator,
        }),
        tokenEstimator,
      };
      return createV2ContextEngine(options);
    },
  };
}

function request(
  runId: ReturnType<typeof createRunId>,
  sessionId: ReturnType<typeof createSessionId>,
  sequence: number,
  messages: readonly StoredAgentMessage[],
  options: {
    readonly model?: ModelDescriptor;
    readonly tools?: readonly AIToolSpec[];
    readonly mode?: "NORMAL" | "FORCED_RECOVERY";
  } = {},
) {
  const latest = messages.at(-1);
  if (latest === undefined) throw new Error("fixture request requires a current user message");
  return {
    identity: { runId, sessionId, goal: "fixture goal" },
    turn: { stepId: `step:surface-${String(sequence)}` as never, sequence },
    conversation: snapshot([turn(messages, { runId, sessionId })], { runId, sessionId }),
    input: { kind: "USER_INPUT" as const, userMessageId: latest.message.id },
    model: options.model ?? MODEL,
    tools: options.tools ?? [],
    mode: options.mode ?? "NORMAL",
    signal: new AbortController().signal,
  };
}

function fullHistory(
  runId: ReturnType<typeof createRunId>,
  sessionId: ReturnType<typeof createSessionId>,
  sequence: number,
): StoredAgentMessage[] {
  const messages: StoredAgentMessage[] = [
    userMessage({ runId, sessionId, sequence: 1, text: "First request." }),
  ];
  for (let index = 2; index < sequence; index += 1) {
    if (index % 2 === 0) {
      messages.push(
        assistantMessage({ runId, sessionId, sequence: index, text: "Previous answer." }),
      );
    } else {
      messages.push(userMessage({ runId, sessionId, sequence: index, text: "Follow-up request." }));
    }
  }
  return messages;
}

describe("Prompt Surface Context Engine integration", () => {
  it("rejects cache replay when a later anchor survives but an earlier model message was dropped", () => {
    const value = fixture();
    const earlier = userMessage({
      runId: value.runId,
      sessionId: value.sessionId,
      sequence: 1,
      text: "Earlier request.",
    });
    const later = assistantMessage({
      runId: value.runId,
      sessionId: value.sessionId,
      sequence: 2,
      text: "Later answer.",
    });
    const originalRequestMessages = [earlier, later];
    const truncatedProjection = [later];

    expect(truncatedProjection.at(-1)?.sequence).toBe(later.sequence);
    expect(
      promptProjectionPreservesUncoveredModelMessages({
        conversationMessages: originalRequestMessages,
        selectedMessages: truncatedProjection,
        coveredMessageIds: new Set(),
      }),
    ).toBe(false);
    expect(
      promptProjectionPreservesUncoveredModelMessages({
        conversationMessages: originalRequestMessages,
        selectedMessages: truncatedProjection,
        coveredMessageIds: new Set([String(earlier.message.id)]),
      }),
    ).toBe(true);
  });

  it("rejects model and Tool identity changes when selecting a compaction replay prefix", async () => {
    const value = fixture();
    const history = fullHistory(value.runId, value.sessionId, 2);
    const engine = value.engine();
    await engine.prepare(
      request(value.runId, value.sessionId, 1, [history[0]!], { tools: [TOOL_A] }),
    );
    const current = value.store.inspect(value.runId)!;
    const identity = {
      stableHeadFingerprint: current.stableHeadFingerprint,
      toolSchemaFingerprint: current.toolSchemaFingerprint,
      cacheSettingsFingerprint: current.cacheSettingsFingerprint,
    };

    expect(promptSurfaceReplayIdentityMatches({ current, model: MODEL, identity })).toBe(true);
    expect(
      promptSurfaceReplayIdentityMatches({
        current,
        model: { ...MODEL, ref: { provider: "fixture", model: "surface-changed" } },
        identity,
      }),
    ).toBe(false);
    expect(
      promptSurfaceReplayIdentityMatches({
        current,
        model: MODEL,
        identity: { ...identity, toolSchemaFingerprint: `sha256:${"d".repeat(64)}` },
      }),
    ).toBe(false);
  });

  it("binds replay identity to the latest durable checkpoint even when the rendered head is unchanged", () => {
    const oldCheckpointHead = promptSurfaceStableHeadFingerprint({
      stableHead: "stable policy",
      checkpointId: "checkpoint:old",
    });
    const newCheckpointHead = promptSurfaceStableHeadFingerprint({
      stableHead: "stable policy",
      checkpointId: "checkpoint:new",
    });
    const current = {
      modelRef: MODEL.ref,
      stableHeadFingerprint: oldCheckpointHead,
      toolSchemaFingerprint: `sha256:${"b".repeat(64)}`,
      cacheSettingsFingerprint: `sha256:${"c".repeat(64)}`,
    };

    expect(newCheckpointHead).not.toBe(oldCheckpointHead);
    expect(
      promptSurfaceReplayIdentityMatches({
        current,
        model: MODEL,
        identity: {
          stableHeadFingerprint: newCheckpointHead,
          toolSchemaFingerprint: current.toolSchemaFingerprint,
          cacheSettingsFingerprint: current.cacheSettingsFingerprint,
        },
      }),
    ).toBe(false);
  });

  it("persists one V3 decision per Step and emits only changed Section state", async () => {
    const value = fixture();
    const completeHistory = fullHistory(value.runId, value.sessionId, 8);
    const firstHistory = completeHistory.slice(0, 1);
    const firstRequest = request(value.runId, value.sessionId, 1, [firstHistory[0]!]);
    const engine = value.engine();
    const first = await engine.prepare(firstRequest);
    const firstSurface = value.store.inspect(value.runId)!;
    const firstRecord = firstSurface.records?.[0]!;

    const sameRetry = await engine.prepare(firstRequest);
    expect(sameRetry.messages).toEqual(first.messages);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(1);

    value.state.dynamicText = "workspace state: changed during retry";
    await expect(engine.prepare(firstRequest)).rejects.toBeInstanceOf(PromptSurfaceIntegrityError);
    expect(value.store.inspect(value.runId)?.records?.[0]).toMatchObject({
      ordinal: firstRecord.ordinal,
      sourceStepSequence: firstRecord.sourceStepSequence,
      contentHash: firstRecord.contentHash,
      createdAt: firstRecord.createdAt,
    });

    value.state.dynamicText = "workspace state: clean";
    const secondMessages = completeHistory.slice(0, 3);
    const secondRequest = request(value.runId, value.sessionId, 2, secondMessages.slice(0, 3));
    const second = await engine.prepare(secondRequest);
    expect(
      first.messages.every(
        (message, index) => JSON.stringify(message) === JSON.stringify(second.messages[index]),
      ),
    ).toBe(true);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(2);
    expect(value.store.inspect(value.runId)?.records?.at(-1)?.kind).toBe("NOOP");
    await engine.prepare(secondRequest);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(2);
    value.state.dynamicText = "changed on NOOP retry";
    await expect(engine.prepare(secondRequest)).rejects.toBeInstanceOf(PromptSurfaceIntegrityError);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(2);

    value.state.dynamicText = undefined;
    const thirdMessages = completeHistory.slice(0, 5);
    const third = await engine.prepare(
      request(value.runId, value.sessionId, 3, thirdMessages.slice(0, 5)),
    );
    const cleared = value.store.inspect(value.runId)?.records?.at(-1);
    expect(cleared).toMatchObject({ ordinal: 3, sourceStepSequence: 3, kind: "DELTA" });
    expect(cleared?.updates).toEqual([expect.objectContaining({ op: "CLEAR" })]);
    expect(third.messages.some((message) => message.content.includes("<clear key="))).toBe(true);

    const fourthMessages = completeHistory.slice(0, 7);
    const fourth = await engine.prepare(
      request(value.runId, value.sessionId, 4, fourthMessages.slice(0, 7)),
    );
    expect(value.store.inspect(value.runId)?.records).toHaveLength(4);
    expect(value.store.inspect(value.runId)?.records?.at(-1)?.kind).toBe("NOOP");
    expect(fourth.messages.slice(0, third.messages.length)).toEqual(third.messages);
    expect(fourth.messages.at(-1)?.content).toBe("Follow-up request.");
    expect(value.state.usage[0]?.promptSurface?.resetReason).toBe("INITIAL");
  });

  it("records explicit reset reasons when model, Tool schema, stable head, API, or settings change", async () => {
    const value = fixture();
    let history = fullHistory(value.runId, value.sessionId, 2);
    let sequence = 1;
    const prepare = async (
      engine: ReturnType<typeof createV2ContextEngine>,
      tools: readonly AIToolSpec[],
      model = MODEL,
    ) => {
      const messages = history;
      const prepared = await engine.prepare(
        request(value.runId, value.sessionId, sequence, messages, { model, tools }),
      );
      const epoch = value.store.inspect(value.runId)!;
      if (sequence > 1) {
        expect(epoch.resetReason).toBe(expectedReasons[sequence - 2]);
      }
      sequence += 1;
      history = fullHistory(value.runId, value.sessionId, sequence * 2);
      return prepared;
    };

    const expectedReasons = [
      "TOOL_SCHEMA_CHANGED",
      "CACHE_SETTINGS_CHANGED",
      "STABLE_HEAD_CHANGED",
      "CACHE_SETTINGS_CHANGED",
      "MODEL_CHANGED",
    ] as const;
    await prepare(value.engine(), [TOOL_A]);
    await prepare(value.engine(), [TOOL_B]);
    await prepare(value.engine({ settings: { temperature: 0.3 } }), [TOOL_B]);
    await prepare(
      value.engine({
        settings: { temperature: 0.3 },
        baseSystemPrompt: "Updated stable policy.",
      }),
      [TOOL_B],
    );
    await prepare(
      value.engine({
        settings: { temperature: 0.3 },
        baseSystemPrompt: "Updated stable policy.",
      }),
      [TOOL_B],
      { ...MODEL, api: "fixture-responses" },
    );
    await prepare(
      value.engine({
        settings: { temperature: 0.3 },
        baseSystemPrompt: "Updated stable policy.",
      }),
      [TOOL_B],
      { ...MODEL, ref: { provider: "fixture", model: "surface-b" } },
    );
    expect(value.state.usage.every((usage) => usage.promptSurface !== undefined)).toBe(true);
  });

  it("starts a new epoch for a changed stable prompt and preserves the old surface byte for byte", async () => {
    const value = fixture();
    const legacyPromptEngine = value.engine({
      baseSystemPrompt:
        "Stable system prompt.\n<run_security_policy>\npolicy_digest=legacy-snapshot-identity\n</run_security_policy>",
    });
    await legacyPromptEngine.prepare(
      request(value.runId, value.sessionId, 1, fullHistory(value.runId, value.sessionId, 2)),
    );
    const oldEpochBeforeChange = value.store.inspectEpochs(value.runId)[0];
    expect(oldEpochBeforeChange).toBeDefined();

    const stablePromptEngine = value.engine({
      baseSystemPrompt:
        "Stable system prompt.\n<run_security_policy>\npolicy_semantic_fingerprint=sha256:new-stable-policy\n</run_security_policy>",
    });
    await stablePromptEngine.prepare(
      request(value.runId, value.sessionId, 2, fullHistory(value.runId, value.sessionId, 4)),
    );

    const epochs = value.store.inspectEpochs(value.runId);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]).toEqual(oldEpochBeforeChange);
    expect(epochs[1]?.resetReason).toBe("STABLE_HEAD_CHANGED");
    expect(epochs[1]?.epochId).not.toBe(oldEpochBeforeChange?.epochId);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(1);
  });

  it("resets an unavailable history anchor and fails closed on a corrupt persisted surface", async () => {
    const value = fixture();
    const engine = value.engine();
    const initial = userMessage({ runId: value.runId, sessionId: value.sessionId, sequence: 1 });
    await engine.prepare(request(value.runId, value.sessionId, 1, [initial]));

    const replacement = userMessage({
      runId: value.runId,
      sessionId: value.sessionId,
      sequence: 3,
    });
    await engine.prepare(request(value.runId, value.sessionId, 2, [replacement]));
    expect(value.store.inspect(value.runId)?.resetReason).toBe("RECOVERY_INCOMPATIBLE");

    value.store.corruptLatestSnapshot(value.runId);
    await expect(
      engine.prepare(request(value.runId, value.sessionId, 2, [replacement])),
    ).rejects.toBeInstanceOf(PromptSurfaceIntegrityError);
  });

  it("does not interpret an optional Context source failure as a Section CLEAR", async () => {
    const value = fixture();
    const engine = value.engine();
    const completeHistory = fullHistory(value.runId, value.sessionId, 3);
    const firstHistory = completeHistory.slice(0, 1);
    await engine.prepare(request(value.runId, value.sessionId, 1, firstHistory));
    const initial = value.store.inspect(value.runId)!;
    expect(
      initial.sectionStates?.some((state) => state.content.includes("workspace state: clean")),
    ).toBe(true);

    value.state.dynamicSourceFails = true;
    const second = await engine.prepare(request(value.runId, value.sessionId, 2, completeHistory));
    expect(value.store.inspectEpochs(value.runId)).toHaveLength(1);
    expect(value.store.inspect(value.runId)?.records?.at(-1)?.kind).toBe("NOOP");
    expect(value.store.inspect(value.runId)?.sectionStates).toEqual(initial.sectionStates);
    expect(
      second.messages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("<runtime_context_"),
      ),
    ).toHaveLength(1);
  });

  it("keeps a V2 Epoch immutable and performs one durable compatibility reset to V3", async () => {
    const value = fixture();
    const history = fullHistory(value.runId, value.sessionId, 1);
    const legacy = createPromptSurfaceEpoch({
      runId: value.runId,
      epochId: "legacy-v2-epoch",
      modelRef: MODEL.ref,
      stableHeadFingerprint: `sha256:${"a".repeat(64)}`,
      toolSchemaFingerprint: `sha256:${"b".repeat(64)}`,
      cacheSettingsFingerprint: `sha256:${"c".repeat(64)}`,
      resetReason: "INITIAL",
      createdStepSequence: 1,
      createdAt: 1 as TimestampMs,
    });
    await value.store.createEpoch(legacy);
    const anchor = latestCompletePromptSurfaceAnchor(history);
    const legacySnapshot = createPromptSurfaceSnapshot({
      runId: value.runId,
      epochId: legacy.epochId,
      ordinal: 1,
      anchor,
      sourceStepSequence: 1,
      kind: "RUNTIME_CONTEXT_SNAPSHOT",
      content: "immutable V2 complete snapshot",
      createdAt: 2 as TimestampMs,
    });
    await value.store.appendSnapshot(legacySnapshot, legacy);

    const engine = value.engine();
    const input = request(value.runId, value.sessionId, 1, history);
    await engine.prepare(input);
    const firstReset = value.store.inspect(value.runId)!;
    expect(firstReset.formatVersion).toBe(3);
    expect(firstReset.resetReason).toBe("RECOVERY_INCOMPATIBLE");
    expect(value.store.inspectEpochs(value.runId)).toHaveLength(2);
    expect(value.store.inspectEpochs(value.runId)[0]).toMatchObject({
      formatVersion: 2,
      snapshots: [legacySnapshot],
    });

    await engine.prepare(input);
    expect(value.store.inspectEpochs(value.runId)).toHaveLength(2);
    expect(value.store.inspect(value.runId)?.records).toHaveLength(1);
  });

  it("fails closed on a corrupt surface before compaction replay and leaves it unchanged", async () => {
    const value = fixture();
    const historicalRunId = createRunId();
    const historical = userMessage({
      runId: historicalRunId,
      sessionId: value.sessionId,
      sequence: 1,
      text: "Earlier request.",
    });
    const current = userMessage({
      runId: value.runId,
      sessionId: value.sessionId,
      sequence: 2,
      text: "Current request.",
    });
    const conversation = snapshot(
      [
        turn([historical], {
          runId: historicalRunId,
          sessionId: value.sessionId,
          status: "CLOSED",
        }),
        turn([current], { runId: value.runId, sessionId: value.sessionId, openedAt: 2 }),
      ],
      { runId: value.runId, sessionId: value.sessionId },
    );
    const warmRequest = {
      ...request(value.runId, value.sessionId, 1, [historical, current]),
      conversation,
    };
    const engine = value.engine();
    await engine.prepare(warmRequest);
    const warmSurface = value.store.inspect(value.runId)!;
    expect(warmSurface.records).toHaveLength(1);

    value.store.corruptLatestSnapshot(value.runId);
    const corruptedSurface = value.store.inspect(value.runId)!;
    await expect(
      engine.prepare({ ...warmRequest, mode: "FORCED_RECOVERY" }),
    ).rejects.toBeInstanceOf(PromptSurfaceIntegrityError);

    expect(value.store.inspect(value.runId)).toEqual(corruptedSurface);
    expect(value.store.inspect(value.runId)?.epochId).toBe(warmSurface.epochId);
  });
});
