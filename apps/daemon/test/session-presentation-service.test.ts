import {
  AgentRunSchema,
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
    expect(response.capabilityVersion).toBe(2);
    expect(response.items.map((item) => item.kind)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL",
      "ASSISTANT",
      "RUN_SUMMARY",
    ]);
    expect(response.items[1]).toMatchObject({
      phase: "COMMENTARY",
      text: expect.stringContaining("inspect"),
      sourceStepId: STEP_ID,
    });
    expect(response.items[3]).toMatchObject({ phase: "FINAL_ANSWER", sourceStepId: STEP_ID });
    const tool = response.items[2] as ToolPresentationItem;
    expect(tool.preview).toBe("安全预览");
    expect(JSON.stringify(tool)).not.toContain("must-not-leak");
    expect(response.items[4]).toMatchObject({ kind: "RUN_SUMMARY", runStatus: "COMPLETED" });
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
    const verification = response.items.filter((item) => item.kind === "VERIFICATION");
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
    const summary = response.items.find((item) => item.kind === "RUN_SUMMARY");

    expect(summary).toMatchObject({
      kind: "RUN_SUMMARY",
      runStatus: "FAILED",
      text: "校验未能完成，任务已失败。",
    });
    expect(JSON.stringify(response)).not.toContain("native exception");
    expect(JSON.stringify(response)).not.toContain("credential-value");
    expect(JSON.stringify(response)).not.toContain("unbounded command output");
    expect(JSON.stringify(response)).not.toContain("C:\\\\host");
  });
});
