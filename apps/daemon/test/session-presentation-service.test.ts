import {
  AgentRunSchema,
  PromptCacheUsageSchema,
  ToolInvocationSchema,
  ToolObservationSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationPlanId,
  createWorkspaceId,
  type DurableRunEvent,
  type ToolPresentationItem,
} from "@caelush/protocol";
import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  agentAssistantTextPart,
  agentTextPart,
  modelMessageSource,
  userMessageSource,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";

import { SessionPresentationService } from "../src/services/session-presentation-service.js";
import {
  projectPromptCacheUsage,
  promptCacheSamplesFromDurableMessages,
  type PromptCacheUsageSample,
} from "../src/daemon-composition.js";

const NOW = createTimestampMs(1_700_000_000_000);
const SESSION_ID = createSessionId();
const RUN_ID = createRunId();
const STEP_ID = createStepId();
const TURN_ID = createDeterministicConversationTurnIdFactory().forRun(RUN_ID);

const RUN = AgentRunSchema.parse({
  id: RUN_ID,
  sessionId: SESSION_ID,
  goal: "inspect the project",
  status: "COMPLETED",
  workspace: { id: createWorkspaceId(), path: "/repo" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "local", kind: "fixture" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: NOW + 10,
});

const turns = createDeterministicConversationTurnIdFactory();
const factory = createAgentMessageFactory({
  ids: createAgentMessageIdFactory(),
  now: () => NOW,
  turns,
});
const codecs = createStandardAgentMessageCodecRegistry(() => 1);

function record(
  message: ReturnType<typeof factory.createUser> | ReturnType<typeof factory.createAssistant>,
  sequence: number,
) {
  const draft = codecs.encode(message);
  return {
    messageId: message.id,
    runId: message.runId,
    sessionId: message.sessionId,
    sequence,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: draft.schemaVersion,
    modelProjectionVersion: draft.modelProjectionVersion,
    sourceStepId: message.sourceStepId,
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data: draft.data,
  } as never;
}

function event(sequence: number, type: string, payload: Record<string, unknown>): DurableRunEvent {
  return {
    eventId: `evt_${String(sequence)}` as never,
    schemaVersion: 1,
    type,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ID,
    timestamp: NOW + sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload,
  } as never;
}

describe("SessionPresentationService", () => {
  it("orders durable messages and safe Tool activity, preserving assistant phases", async () => {
    const user = factory.createUser({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      conversationTurnId: TURN_ID,
      source: userMessageSource("GOAL"),
      content: [agentTextPart("inspect the project")],
    });
    const commentary = factory.createAssistant({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      conversationTurnId: TURN_ID,
      sourceStepId: STEP_ID,
      source: modelMessageSource("llm_commentary"),
      phase: "COMMENTARY",
      content: [agentAssistantTextPart("I will inspect the files first.")],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_commentary",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const final = factory.createAssistant({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      conversationTurnId: TURN_ID,
      sourceStepId: STEP_ID,
      source: modelMessageSource("llm_final"),
      phase: "FINAL_ANSWER",
      content: [agentAssistantTextPart("The inspection is complete.")],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_final",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const invocation = ToolInvocationSchema.parse({
      id: createToolInvocationId(),
      runId: RUN_ID,
      stepId: STEP_ID,
      externalCallId: "call_1",
      toolName: "read_file",
      args: { path: "src/index.ts", secret: "must-not-leak" },
      riskLevel: "LOW",
      status: "COMPLETED",
      createdAt: NOW + 4,
      finishedAt: NOW + 5,
    });
    const observation = ToolObservationSchema.parse({
      id: "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      kind: "TOOL",
      runId: RUN_ID,
      stepId: STEP_ID,
      toolInvocationId: invocation.id,
      content: "safe file content",
      details: { path: "src/index.ts" },
      isError: false,
      createdAt: NOW + 6,
    });
    const events = [
      event(1, "conversation.message.committed", {
        messageId: user.id,
        conversationTurnId: TURN_ID,
        messageType: "USER",
      }),
      event(2, "conversation.message.committed", {
        messageId: commentary.id,
        conversationTurnId: TURN_ID,
        messageType: "ASSISTANT",
      }),
      event(3, "tool.requested", {
        invocationId: invocation.id,
        toolName: "read_file",
        riskLevel: "LOW",
      }),
      event(4, "tool.completed", { invocationId: invocation.id, observationId: observation.id }),
      event(5, "conversation.message.committed", {
        messageId: final.id,
        conversationTurnId: TURN_ID,
        messageType: "ASSISTANT",
      }),
      event(6, "run.completed", { result: "verified" }),
    ];
    const service = new SessionPresentationService({
      sessions: { get: async () => ({ id: SESSION_ID }) as never },
      runs: { listBySession: async () => [RUN] },
      messageRecords: {
        listBySession: async () => [record(user, 1), record(commentary, 2), record(final, 5)],
      },
      codecs,
      toolInvocations: { listByRun: async () => [invocation] },
      observations: { listByRun: async () => [observation] },
      eventReader: {
        latestSequence: async () => 6,
        replay: async () => events,
      },
      toolPresentation: {
        presentInvocation: () => ({ title: "读取文件", summary: "读取 src/index.ts" }),
        presentResult: () => ({
          title: "读取文件",
          summary: "读取文件 src/index.ts",
          output: { stream: "stdout", chunk: "安全预览" },
        }),
        presentShellCommand: () => "执行命令",
      },
    });

    const response = await service.getPresentation(SESSION_ID, {});
    expect(response.capabilityVersion).toBe(3);
    expect(response.turns).toHaveLength(1);
    const items = response.turns[0]!.items;
    expect(items.map((item) => item.kind)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL",
      "ASSISTANT",
      "RUN_SUMMARY",
    ]);
    expect(items[1]).toMatchObject({
      phase: "COMMENTARY",
      text: expect.stringContaining("inspect"),
      sourceStepId: STEP_ID,
    });
    expect(items[3]).toMatchObject({ phase: "FINAL_ANSWER", sourceStepId: STEP_ID });
    const tool = items[2] as ToolPresentationItem;
    expect(tool.preview).toBe("安全预览");
    expect(JSON.stringify(tool)).not.toContain("must-not-leak");
    expect(items[4]).toMatchObject({ kind: "RUN_SUMMARY", runStatus: "COMPLETED" });
    expect(new Set(items.map((item) => item.conversationTurnId))).toEqual(new Set([TURN_ID]));
    expect(items.every((item, ordinal) => item.ordinal === ordinal)).toBe(true);
    expect(response.turns[0]).toMatchObject({
      runId: RUN_ID,
      conversationTurnId: TURN_ID,
      runStatus: "COMPLETED",
      openedAt: RUN.createdAt,
      closedAt: RUN.finishedAt,
      highWatermark: 6,
    });
  });

  it("merges verification lifecycle pairs and leaves no streaming rows for a terminal Run", async () => {
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    const events = [
      event(1, "verification.planned", { planId, checkCount: 1 }),
      event(2, "verification.check.started", { planId, checkId }),
      event(3, "verification.check.completed", {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: ["evidence-safe"],
      }),
      event(4, "verification.finalized", { planId, outcome: "PASSED" }),
    ];
    const service = new SessionPresentationService({
      sessions: { get: async () => ({ id: SESSION_ID }) as never },
      runs: { listBySession: async () => [RUN] },
      messageRecords: { listBySession: async () => [] },
      codecs,
      toolInvocations: { listByRun: async () => [] },
      observations: { listByRun: async () => [] },
      eventReader: {
        latestSequence: async () => 4,
        replay: async () => events,
      },
      toolPresentation: {
        presentInvocation: () => ({ title: "使用工具", summary: "工具调用" }),
        presentResult: () => ({ title: "使用工具", summary: "工具结果" }),
        presentShellCommand: () => "执行命令",
      },
    });

    const response = await service.getPresentation(SESSION_ID, {});
    const verification = response.turns[0]!.items.filter((item) => item.kind === "VERIFICATION");
    expect(verification).toHaveLength(3);
    expect(verification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verificationId: planId,
          title: "验证计划",
          status: "COMPLETED",
        }),
        expect.objectContaining({
          verificationId: checkId,
          title: "验证检查",
          summary: "检查通过",
          status: "COMPLETED",
        }),
        expect.objectContaining({ title: "验证定稿", status: "COMPLETED" }),
      ]),
    );
    expect(verification.some((item) => item.status === "STREAMING")).toBe(false);
    expect(new Set(verification.map((item) => item.conversationTurnId))).toEqual(
      new Set([TURN_ID]),
    );
  });

  it("projects a bounded verification failure reason without exposing raw error data", async () => {
    const failedRun = AgentRunSchema.parse({
      ...RUN,
      status: "FAILED",
      finishedAt: createTimestampMs(Number(NOW) + 10),
    });
    const rawError = {
      code: "VERIFICATION_FAILED",
      message: "native exception at C:\\Users\\han\\secrets\\token=credential-value",
      retryable: false,
      phase: "VERIFICATION",
      details: { stdout: "unbounded command output", absolutePath: "C:\\host\\workspace" },
    };
    const service = new SessionPresentationService({
      sessions: { get: async () => ({ id: SESSION_ID }) as never },
      runs: { listBySession: async () => [failedRun] },
      messageRecords: { listBySession: async () => [] },
      codecs,
      toolInvocations: { listByRun: async () => [] },
      observations: { listByRun: async () => [] },
      eventReader: {
        latestSequence: async () => 1,
        replay: async () => [event(1, "error", { error: rawError })],
      },
      toolPresentation: {
        presentInvocation: () => ({ title: "使用工具", summary: "工具调用" }),
        presentResult: () => ({ title: "使用工具", summary: "工具结果" }),
        presentShellCommand: () => "执行命令",
      },
    });

    const response = await service.getPresentation(SESSION_ID, {});
    const summary = response.turns[0]!.items.find((item) => item.kind === "RUN_SUMMARY");

    expect(summary).toMatchObject({
      kind: "RUN_SUMMARY",
      runStatus: "FAILED",
      text: "校验未能完成，任务已失败。",
    });
    expect(response.turns[0]).toMatchObject({ conversationTurnId: turns.forRun(failedRun.id) });
    expect(JSON.stringify(response)).not.toContain("native exception");
    expect(JSON.stringify(response)).not.toContain("credential-value");
    expect(JSON.stringify(response)).not.toContain("unbounded command output");
    expect(JSON.stringify(response)).not.toContain("C:\\\\host");
  });

  it("keeps colliding local message sequences, summaries and event watermarks inside their Run Turns", async () => {
    const runOneId = createRunId();
    const runTwoId = createRunId();
    const runThreeId = createRunId();
    const runOne = AgentRunSchema.parse({
      ...RUN,
      id: runOneId,
      status: "COMPLETED",
      createdAt: NOW,
      finishedAt: NOW + 20,
    });
    const runTwo = AgentRunSchema.parse({
      ...RUN,
      id: runTwoId,
      status: "FAILED",
      createdAt: NOW + 30,
      finishedAt: NOW + 50,
    });
    const runThree = AgentRunSchema.parse({
      ...RUN,
      id: runThreeId,
      status: "COMPLETED",
      createdAt: NOW + 60,
      finishedAt: NOW + 80,
    });
    const runOneTurnId = turns.forRun(runOneId);
    const runTwoTurnId = turns.forRun(runTwoId);
    const runThreeTurnId = turns.forRun(runThreeId);
    const runOneUser = factory.createUser({
      runId: runOneId,
      sessionId: SESSION_ID,
      conversationTurnId: runOneTurnId,
      source: userMessageSource("GOAL"),
      content: [agentTextPart("first task")],
    });
    const runOneCommentary = factory.createAssistant({
      runId: runOneId,
      sessionId: SESSION_ID,
      conversationTurnId: runOneTurnId,
      sourceStepId: STEP_ID,
      source: modelMessageSource("run-one-commentary"),
      phase: "COMMENTARY",
      content: [agentAssistantTextPart("first task is starting")],
      model: {
        kind: "MODEL_TURN",
        callId: "run-one-commentary",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const runOneFinal = factory.createAssistant({
      runId: runOneId,
      sessionId: SESSION_ID,
      conversationTurnId: runOneTurnId,
      sourceStepId: STEP_ID,
      source: modelMessageSource("run-one-final"),
      phase: "FINAL_ANSWER",
      content: [agentAssistantTextPart("first task complete")],
      model: {
        kind: "MODEL_TURN",
        callId: "run-one-final",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const runTwoUser = factory.createUser({
      runId: runTwoId,
      sessionId: SESSION_ID,
      conversationTurnId: runTwoTurnId,
      source: userMessageSource("GOAL"),
      content: [agentTextPart("second task")],
    });
    const runTwoCommentary = factory.createAssistant({
      runId: runTwoId,
      sessionId: SESSION_ID,
      conversationTurnId: runTwoTurnId,
      sourceStepId: STEP_ID,
      source: modelMessageSource("run-two-commentary"),
      phase: "COMMENTARY",
      content: [agentAssistantTextPart("second task is starting")],
      model: {
        kind: "MODEL_TURN",
        callId: "run-two-commentary",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const runTwoFinal = factory.createAssistant({
      runId: runTwoId,
      sessionId: SESSION_ID,
      conversationTurnId: runTwoTurnId,
      sourceStepId: STEP_ID,
      source: modelMessageSource("run-two-final"),
      phase: "FINAL_ANSWER",
      content: [agentAssistantTextPart("second task failed")],
      model: {
        kind: "MODEL_TURN",
        callId: "run-two-final",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const runThreeUser = factory.createUser({
      runId: runThreeId,
      sessionId: SESSION_ID,
      conversationTurnId: runThreeTurnId,
      source: userMessageSource("GOAL"),
      content: [agentTextPart("third task")],
    });
    const runThreeFinal = factory.createAssistant({
      runId: runThreeId,
      sessionId: SESSION_ID,
      conversationTurnId: runThreeTurnId,
      sourceStepId: STEP_ID,
      source: modelMessageSource("run-three-final"),
      phase: "FINAL_ANSWER",
      content: [agentAssistantTextPart("third task complete")],
      model: {
        kind: "MODEL_TURN",
        callId: "run-three-final",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const runOneTool = ToolInvocationSchema.parse({
      id: createToolInvocationId(),
      runId: runOneId,
      stepId: STEP_ID,
      externalCallId: "run-one-call",
      toolName: "read_file",
      args: { path: "src/one.ts" },
      riskLevel: "LOW",
      status: "COMPLETED",
      createdAt: NOW + 4,
      finishedAt: NOW + 5,
    });
    const runTwoTool = ToolInvocationSchema.parse({
      id: createToolInvocationId(),
      runId: runTwoId,
      stepId: STEP_ID,
      externalCallId: "run-two-call",
      toolName: "read_file",
      args: { path: "src/two.ts" },
      riskLevel: "LOW",
      status: "COMPLETED",
      createdAt: NOW + 34,
      finishedAt: NOW + 35,
    });
    const service = new SessionPresentationService({
      sessions: { get: async () => ({ id: SESSION_ID }) as never },
      // Deliberately return reverse order; Session order comes from Run createdAt + stable id.
      runs: { listBySession: async () => [runThree, runTwo, runOne] },
      messageRecords: {
        listBySession: async () => [
          record(runThreeUser, 1),
          record(runThreeFinal, 5),
          record(runTwoUser, 1),
          record(runTwoCommentary, 2),
          record(runTwoFinal, 3),
          record(runOneUser, 1),
          record(runOneCommentary, 2),
          record(runOneFinal, 8),
        ],
      },
      codecs,
      toolInvocations: {
        listByRun: async (runId) =>
          runId === runOneId ? [runOneTool] : runId === runTwoId ? [runTwoTool] : [],
      },
      observations: { listByRun: async () => [] },
      eventReader: {
        latestSequence: async (runId) => (runId === runOneId ? 85 : runId === runTwoId ? 7 : 4),
        replay: async () => [],
      },
      toolPresentation: {
        presentInvocation: () => ({ title: "使用工具", summary: "工具调用" }),
        presentResult: () => ({ title: "使用工具", summary: "工具结果" }),
        presentShellCommand: () => "执行命令",
      },
    });

    const response = await service.getPresentation(SESSION_ID, {});

    expect(response.capabilityVersion).toBe(3);
    expect(response).not.toHaveProperty("highWatermark");
    expect(response.turns.map((turn) => turn.runId)).toEqual([runOneId, runTwoId, runThreeId]);
    expect(response.turns.map((turn) => turn.highWatermark)).toEqual([85, 7, 4]);
    expect(response.turns[0]!.items.map((item) => item.kind)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL",
      "ASSISTANT",
      "RUN_SUMMARY",
    ]);
    expect(response.turns[1]!.items.map((item) => item.kind)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL",
      "ASSISTANT",
      "RUN_SUMMARY",
    ]);
    expect(response.turns[2]!.items.map((item) => item.kind)).toEqual([
      "USER",
      "ASSISTANT",
      "RUN_SUMMARY",
    ]);
    expect(response.turns[0]!.items.every((item) => item.runId === runOneId)).toBe(true);
    expect(response.turns[1]!.items.every((item) => item.runId === runTwoId)).toBe(true);
    expect(response.turns[2]!.items.every((item) => item.runId === runThreeId)).toBe(true);
    expect(response.turns[0]!.items.every((item) => item.conversationTurnId === runOneTurnId)).toBe(
      true,
    );
    expect(response.turns[1]!.items.every((item) => item.conversationTurnId === runTwoTurnId)).toBe(
      true,
    );
    expect(
      response.turns[2]!.items.every((item) => item.conversationTurnId === runThreeTurnId),
    ).toBe(true);
    expect(response.turns[1]!.items.at(-1)).toMatchObject({
      kind: "RUN_SUMMARY",
      runStatus: "FAILED",
      conversationTurnId: runTwoTurnId,
    });
  });

  it("paginates only at Turn boundaries and includes empty-message Runs", async () => {
    const emptyRunId = createRunId();
    const followingRunId = createRunId();
    const emptyRun = AgentRunSchema.parse({
      ...RUN,
      id: emptyRunId,
      status: "RUNNING",
      createdAt: NOW,
      finishedAt: undefined,
    });
    const followingRun = AgentRunSchema.parse({
      ...RUN,
      id: followingRunId,
      status: "RUNNING",
      createdAt: NOW + 1,
      finishedAt: undefined,
    });
    let commentaryTime = Number(NOW);
    const commentaryFactory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(++commentaryTime),
      turns,
    });
    const manyComments = Array.from({ length: 20 }, (_, index) => {
      const callId = `commentary-${index + 1}`;
      return commentaryFactory.createAssistant({
        runId: followingRunId,
        sessionId: SESSION_ID,
        conversationTurnId: turns.forRun(followingRunId),
        sourceStepId: STEP_ID,
        source: modelMessageSource(callId),
        phase: "COMMENTARY",
        content: [agentAssistantTextPart(`commentary ${index + 1}`)],
        model: {
          kind: "MODEL_TURN",
          callId,
          model: { provider: "fixture", model: "fixture-model" },
          finishReason: "TOOL_CALLS",
        },
      });
    });
    const service = new SessionPresentationService({
      sessions: { get: async () => ({ id: SESSION_ID }) as never },
      runs: { listBySession: async () => [followingRun, emptyRun] },
      messageRecords: {
        listBySession: async () => manyComments.map((message, index) => record(message, index + 1)),
      },
      codecs,
      toolInvocations: { listByRun: async () => [] },
      observations: { listByRun: async () => [] },
      eventReader: { latestSequence: async () => 0, replay: async () => [] },
      toolPresentation: {
        presentInvocation: () => ({ title: "使用工具", summary: "工具调用" }),
        presentResult: () => ({ title: "使用工具", summary: "工具结果" }),
        presentShellCommand: () => "执行命令",
      },
    });

    const firstPage = await service.getPresentation(SESSION_ID, { limit: 1 });
    expect(firstPage.turns).toHaveLength(1);
    expect(firstPage.turns[0]).toMatchObject({
      runId: emptyRunId,
      conversationTurnId: turns.forRun(emptyRunId),
      items: [],
    });
    expect(firstPage.nextCursor).toBe(emptyRunId);

    const secondPage = await service.getPresentation(SESSION_ID, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.turns).toHaveLength(1);
    expect(secondPage.turns[0]!.items).toHaveLength(20);
    expect(secondPage.turns[0]!.items.map((item) => item.ordinal)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(secondPage.nextCursor).toBeUndefined();
  });
});

describe("Prompt Cache daemon projection", () => {
  const usageInput = {
    runId: RUN_ID,
    modelRef: { provider: "fixture-provider", model: "fixture-model" },
    contextWindowTokens: 16_000,
    effectiveInputLimitTokens: 12_000,
    estimatedInputTokens: 4_000,
    remainingTokens: 8_000,
    pressureState: "NORMAL",
    compactionCount: 0,
    breakdown: [],
    lastBuildStatus: "SUCCESS",
    updatedAt: NOW,
    promptSurface: {
      epochId: "epoch-safe-1",
      prefixFingerprint: `sha256:${"a".repeat(64)}`,
      stableHeadTokens: 800,
      snapshotTokens: 200,
      expectedReusablePrefixTokens: 1_000,
      resetReason: "INITIAL",
    },
  } as never;
  const initialEpoch = {
    epochId: "epoch-safe-1",
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: NOW,
  } as never;

  it.each([
    {
      status: "WARM",
      epoch: initialEpoch,
      samples: [
        {
          purpose: "MAIN_AGENT",
          measuredAt: NOW + 1,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheMissInputTokens: 20,
            cacheWriteInputTokens: 5,
          },
        },
      ],
    },
    {
      status: "COLD_START",
      epoch: initialEpoch,
      samples: [
        {
          purpose: "MAIN_AGENT",
          measuredAt: NOW + 1,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheMissInputTokens: 100,
            cacheWriteInputTokens: 0,
          },
        },
      ],
    },
    {
      status: "RESET",
      epoch: {
        epochId: "epoch-safe-2",
        resetReason: "CACHE_SETTINGS_CHANGED",
        createdStepSequence: 3,
        createdAt: NOW + 3,
      },
      samples: [
        {
          purpose: "MAIN_AGENT",
          measuredAt: NOW + 1,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheMissInputTokens: 20,
            cacheWriteInputTokens: 0,
          },
        },
      ],
    },
    {
      status: "UNREPORTED",
      epoch: initialEpoch,
      samples: [{ purpose: "MAIN_AGENT", measuredAt: NOW + 1 }],
    },
  ] as const)("projects the $status cache status", ({ status, epoch, samples }) => {
    const result = projectPromptCacheUsage(
      usageInput,
      samples as readonly PromptCacheUsageSample[],
      epoch,
    );
    expect(result.status).toBe(status);
    if (status === "RESET") {
      expect(result).toMatchObject({
        resetReason: "CACHE_SETTINGS_CHANGED",
        resetStepSequence: 3,
        resetAt: NOW + 3,
      });
    }
    if (status === "UNREPORTED") {
      expect(result.latestHitRate).toBeUndefined();
      expect(result.rollingHitRate).toBeUndefined();
      expect(result.reusablePrefixEfficiency).toBeUndefined();
    }
  });

  it("aggregates by purpose and weights rolling rates by tokens", () => {
    const samples: readonly PromptCacheUsageSample[] = [
      {
        purpose: "MAIN_AGENT",
        measuredAt: NOW + 1,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheMissInputTokens: 20,
          cacheWriteInputTokens: 5,
        },
      },
      {
        purpose: "WARMUP",
        measuredAt: NOW + 2,
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 900,
          cacheMissInputTokens: 100,
          cacheWriteInputTokens: 0,
        },
      },
      { purpose: "COMPACTION", measuredAt: NOW + 3 },
    ];
    const result = projectPromptCacheUsage(usageInput, samples, initialEpoch);

    expect(result).toMatchObject({
      status: "WARM",
      sampleCount: 2,
      totalRequestCount: 3,
      totalInputTokens: 1_100,
      totalOutputTokens: 0,
      hitTokens: 980,
      missTokens: 120,
      writeTokens: 5,
      unknownUsageCount: 1,
      latestHitRate: 0.9,
      rollingHitRate: 980 / 1_100,
      expectedReusablePrefixTokens: 1_000,
      reusablePrefixEfficiency: 0.9,
      epochId: "epoch-safe-1",
      resetReason: "INITIAL",
      lastMeasuredAt: NOW + 2,
    });
    expect(result.purposes).toEqual([
      {
        purpose: "MAIN_AGENT",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 0,
        hitTokens: 80,
        missTokens: 20,
        writeTokens: 5,
        unknownUsageCount: 0,
      },
      {
        purpose: "WARMUP",
        requestCount: 1,
        inputTokens: 1_000,
        outputTokens: 0,
        hitTokens: 900,
        missTokens: 100,
        writeTokens: 0,
        unknownUsageCount: 0,
      },
      {
        purpose: "COMPACTION",
        requestCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        hitTokens: 0,
        missTokens: 0,
        writeTokens: 0,
        unknownUsageCount: 1,
      },
    ]);
  });

  it("ignores a zero-token latest request when reporting cache rates", () => {
    const samples: readonly PromptCacheUsageSample[] = [
      {
        purpose: "MAIN_AGENT",
        measuredAt: NOW + 1,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheMissInputTokens: 20,
          cacheWriteInputTokens: 0,
        },
      },
      {
        purpose: "RETRY",
        measuredAt: NOW + 2,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      },
    ];

    const result = PromptCacheUsageSchema.parse(
      projectPromptCacheUsage(usageInput, samples, initialEpoch),
    );

    expect(result).toMatchObject({
      status: "WARM",
      sampleCount: 1,
      totalRequestCount: 2,
      totalInputTokens: 100,
      latestHitRate: 0.8,
      rollingHitRate: 0.8,
      expectedReusablePrefixTokens: 1_000,
      reusablePrefixEfficiency: 0.08,
      lastMeasuredAt: NOW + 1,
    });
  });

  it("leaves rates unreported when every measured request has zero cache tokens", () => {
    const samples: readonly PromptCacheUsageSample[] = [
      {
        purpose: "MAIN_AGENT",
        measuredAt: NOW + 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      },
    ];

    const result = PromptCacheUsageSchema.parse(
      projectPromptCacheUsage(usageInput, samples, initialEpoch),
    );

    expect(result).toMatchObject({
      status: "UNREPORTED",
      sampleCount: 0,
      totalRequestCount: 1,
      totalInputTokens: 0,
      expectedReusablePrefixTokens: 1_000,
    });
    expect(result.latestHitRate).toBeUndefined();
    expect(result.rollingHitRate).toBeUndefined();
    expect(result.reusablePrefixEfficiency).toBeUndefined();
    expect(result.lastMeasuredAt).toBeUndefined();
  });

  it("combines durable assistant usage with unmatched auxiliary budget entries safely", () => {
    const assistant = factory.createAssistant({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      conversationTurnId: TURN_ID,
      sourceStepId: STEP_ID,
      source: modelMessageSource("fixture-call"),
      phase: "COMMENTARY",
      content: [agentAssistantTextPart("private content must not be projected")],
      model: {
        kind: "MODEL_TURN",
        callId: "fixture-call",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 80,
          cacheMissInputTokens: 20,
          cacheWriteInputTokens: 5,
        },
      },
    });
    const samples = promptCacheSamplesFromDurableMessages([record(assistant, 1)], [
      {
        id: "budget-main",
        runId: RUN_ID,
        kind: "LLM_ATTEMPT",
        ownerId: STEP_ID,
        state: "SETTLED",
        reservedToolCalls: 0,
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
        actualInputTokens: 100,
        actualOutputTokens: 10,
        reservedCostMicros: 0,
        actualCostMicros: 0,
        createdAt: NOW,
        startedAt: NOW,
        settledAt: NOW + 1,
      },
      {
        id: "budget-compaction",
        runId: RUN_ID,
        kind: "CONTEXT_COMPACTION",
        ownerId: "compaction-owner",
        state: "SETTLED",
        reservedToolCalls: 0,
        reservedInputTokens: 300,
        reservedOutputTokens: 100,
        actualInputTokens: 250,
        actualOutputTokens: 40,
        reservedCostMicros: 0,
        actualCostMicros: 0,
        createdAt: NOW + 2,
        startedAt: NOW + 2,
        settledAt: NOW + 3,
      },
    ] as never);

    expect(samples).toEqual([
      {
        purpose: "MAIN_AGENT",
        measuredAt: NOW,
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 80,
          cacheMissInputTokens: 20,
          cacheWriteInputTokens: 5,
        },
      },
      {
        purpose: "COMPACTION",
        measuredAt: NOW + 3,
        usage: { inputTokens: 250, outputTokens: 40 },
      },
    ]);
    expect(JSON.stringify(samples)).not.toContain("private content");
  });
});
