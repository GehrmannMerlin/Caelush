import { describe, expect, it } from "vitest";
import {
  createEventId,
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  createAgentMessageFactory,
  createRequestedToolInvocation,
  createToolObservation,
  createDeterministicConversationTurnIdFactory,
  createRunEventFactory,
  createScriptedAgentMessageIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  completeToolInvocation,
  deriveInterruptedToolResultMessageId,
  fingerprintProjection,
  modelMessageSource,
  startToolInvocation,
  toolFeedbackPolicySnapshot,
  toolMessageSource,
  toolResultObservation,
  NO_TOOL_RESULT_OBSERVATION,
} from "@caelush/agent";
import type { AgentMessageRecordDraft } from "@caelush/agent";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));

describe("interrupted Tool history closure", () => {
  it("atomically appends one ordered result and metadata event without reopening the Run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "CANCELLED",
      finishedAt: createTimestampMs(130),
    });
    const step = makeStep(run.id, {
      status: "COMPLETED",
      finishedAt: createTimestampMs(120),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    const sourceFactory = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory(["amsg_0192f5b1-4d3a-7c2e-8a91-000000000101"]),
      now: () => createTimestampMs(120),
      turns,
    });
    const assistant = sourceFactory.createAssistant({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: modelMessageSource("llm_interrupted"),
      phase: "COMMENTARY",
      content: [
        { type: "TOOL_CALL", toolCallId: "call_a", toolName: "read_file", input: { path: "a" } },
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_interrupted",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const assistantEncoded = codecs.encode(assistant);
    const assistantDraft: AgentMessageRecordDraft = {
      messageId: assistant.id,
      sessionId: session.id,
      conversationTurnId: assistant.conversationTurnId,
      messageType: assistant.type,
      schemaVersion: assistantEncoded.schemaVersion,
      modelProjectionVersion: assistantEncoded.modelProjectionVersion,
      sourceStepId: step.id,
      createdAt: assistant.createdAt,
      source: assistant.source,
      audience: assistant.audience,
      data: assistantEncoded.data,
    };
    const [assistantRecord] = await storage.messageRecords.append(run.id, [assistantDraft]);
    if (assistantRecord === undefined) throw new Error("assistant fixture did not persist");

    const messageId = deriveInterruptedToolResultMessageId({
      sessionId: session.id,
      sourceRunId: run.id,
      assistantMessageId: assistant.id,
      toolCallId: "call_a",
      closureVersion: 1,
    });
    const closureFactory = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory([messageId]),
      now: () => createTimestampMs(140),
      turns,
    });
    const projectedContent =
      "The tool call was not started because the previous run was interrupted. It may be requested again if still needed.";
    const resultMessage = closureFactory.createToolResult({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: toolMessageSource(),
      toolCallId: "call_a",
      toolName: "read_file",
      observation: NO_TOOL_RESULT_OBSERVATION,
      isError: false,
      projectedContent,
      projection: {
        policy: toolFeedbackPolicySnapshot({
          maxSingleObservationTokens: 1000,
          maxObservationBatchTokens: 4000,
        }),
        fingerprint: "closure-fingerprint",
        version: 1,
      },
    });
    const resultEncoded = codecs.encode(resultMessage);
    const resultDraft: AgentMessageRecordDraft = {
      messageId: resultMessage.id,
      sessionId: resultMessage.sessionId,
      conversationTurnId: resultMessage.conversationTurnId,
      messageType: resultMessage.type,
      schemaVersion: resultEncoded.schemaVersion,
      modelProjectionVersion: resultEncoded.modelProjectionVersion,
      sourceStepId: step.id,
      createdAt: resultMessage.createdAt,
      source: resultMessage.source,
      audience: resultMessage.audience,
      data: resultEncoded.data,
    };
    const eventFactory = createRunEventFactory();
    const messageEvent = eventFactory.messageCommitted(
      run,
      {
        messageId: resultMessage.id,
        conversationTurnId: resultMessage.conversationTurnId,
        messageType: "TOOL_RESULT",
      },
      createEventId(),
      createTimestampMs(140),
    );
    const command = {
      sessionId: session.id,
      runId: run.id,
      expectedAssistant: assistantRecord,
      toolCallId: "call_a",
      toolName: "read_file",
      batchToolCallIds: ["call_a"],
      callIndex: 0,
      closureVersion: 1,
      classification: "NOT_STARTED" as const,
      missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED" as const,
      message: resultDraft,
      messageEvent,
    };

    const first = await storage.execution.commitInterruptedHistoryClosure(command);
    const retry = await storage.execution.commitInterruptedHistoryClosure(command);
    const conflictingRetry = {
      ...command,
      message: {
        ...command.message,
        data: { ...command.message.data, projectedContent: "different closure content" },
      },
    };

    expect(first.kind).toBe("APPENDED");
    expect(first.events.map((event) => event.type)).toEqual(["conversation.message.committed"]);
    expect(first.events[0]?.payload).toEqual({
      messageId,
      conversationTurnId: assistant.conversationTurnId,
      messageType: "TOOL_RESULT",
    });
    expect(Object.keys(first.events[0]?.payload ?? {}).sort()).toEqual([
      "conversationTurnId",
      "messageId",
      "messageType",
    ]);
    expect(retry.kind).toBe("ALREADY_PRESENT");
    expect(retry.events).toEqual([]);
    await expect(
      storage.execution.commitInterruptedHistoryClosure(conflictingRetry),
    ).rejects.toThrow();
    expect(
      (await storage.messageRecords.listByRun(run.id)).map((record) => record.messageType),
    ).toEqual(["ASSISTANT", "TOOL_RESULT"]);
    expect(await storage.eventReader.latestSequence(run.id)).toBe(1);
    expect((await storage.runs.get(run.id))?.status).toBe("CANCELLED");
    await storage.close();
  });

  it("rebuilds missing model feedback from the real committed Tool observation", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(101),
    });
    const step = makeStep(run.id, {
      status: "COMPLETED",
      finishedAt: createTimestampMs(130),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    const assistant = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory(["amsg_0192f5b1-4d3a-7c2e-8a91-000000000103"]),
      now: () => createTimestampMs(120),
      turns,
    }).createAssistant({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: modelMessageSource("llm_observed_interruption"),
      phase: "COMMENTARY",
      content: [
        {
          type: "TOOL_CALL",
          toolCallId: "call_observed",
          toolName: "read_file",
          input: { path: "a" },
        },
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_observed_interruption",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const assistantEncoding = codecs.encode(assistant);
    const [assistantRecord] = await storage.messageRecords.append(run.id, [
      {
        messageId: assistant.id,
        sessionId: session.id,
        conversationTurnId: assistant.conversationTurnId,
        messageType: assistant.type,
        schemaVersion: assistantEncoding.schemaVersion,
        modelProjectionVersion: assistantEncoding.modelProjectionVersion,
        sourceStepId: step.id,
        createdAt: assistant.createdAt,
        source: assistant.source,
        audience: assistant.audience,
        data: assistantEncoding.data,
      },
    ]);
    if (assistantRecord === undefined) throw new Error("assistant fixture did not persist");

    const invocation = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId: run.id,
      stepId: step.id,
      externalCallId: "call_observed",
      toolName: "read_file",
      args: { path: "a" },
      riskLevel: "LOW",
      createdAt: createTimestampMs(110),
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation,
      expectedRevision: null,
      events: [],
    });
    const running = startToolInvocation(invocation, createTimestampMs(111));
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation: running,
      expectedRevision: 1,
      events: [],
    });
    const completed = completeToolInvocation(running, createTimestampMs(130));
    const observation = createToolObservation({
      id: createObservationId(),
      runId: run.id,
      stepId: step.id,
      toolInvocationId: invocation.id,
      content: "verified observed content",
      details: {},
      isError: false,
      createdAt: createTimestampMs(130),
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation: completed,
      expectedRevision: 2,
      observation,
      events: [],
    });

    const cancelledRun = {
      ...run,
      status: "CANCELLED" as const,
      finishedAt: createTimestampMs(140),
    };
    await storage.runs.update(cancelledRun);
    await storage.runStates.save({
      runId: run.id,
      sessionId: session.id,
      goal: run.goal,
      status: "CANCELLED",
      workspace: run.workspace,
      runtime: run.runtime,
      permissionProfile: run.permissionProfile,
      approvalPolicy: run.approvalPolicy,
      plan: [],
      recentObservations: [],
      changedFiles: [],
      activeProcesses: [],
      errors: [],
      verification: "NOT_RUN",
      usage: { steps: 0, toolCalls: 1, inputTokens: 0, outputTokens: 0 },
      startedAt: run.startedAt,
      updatedAt: createTimestampMs(140),
    });

    const messageId = deriveInterruptedToolResultMessageId({
      sessionId: session.id,
      sourceRunId: run.id,
      assistantMessageId: assistant.id,
      toolCallId: "call_observed",
      closureVersion: 1,
    });
    const modelResult = {
      role: "tool" as const,
      toolCallId: "call_observed",
      toolName: "read_file",
      content: observation.content,
      isError: observation.isError,
    };
    const policy = {
      maxSingleObservationTokens: 1_000,
      maxObservationBatchTokens: 4_000,
    };
    const resultMessage = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory([messageId]),
      now: () => createTimestampMs(150),
      turns,
    }).createToolResult({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: assistant.conversationTurnId,
      sourceStepId: step.id,
      source: toolMessageSource(),
      toolCallId: "call_observed",
      toolName: "read_file",
      observation: toolResultObservation(observation.id),
      isError: observation.isError,
      projectedContent: modelResult.content,
      projection: {
        policy: toolFeedbackPolicySnapshot(policy),
        fingerprint: fingerprintProjection([modelResult]),
        version: 1,
      },
    });
    const resultEncoding = codecs.encode(resultMessage);
    const resultDraft: AgentMessageRecordDraft = {
      messageId: resultMessage.id,
      sessionId: resultMessage.sessionId,
      conversationTurnId: resultMessage.conversationTurnId,
      messageType: resultMessage.type,
      schemaVersion: resultEncoding.schemaVersion,
      modelProjectionVersion: resultEncoding.modelProjectionVersion,
      sourceStepId: step.id,
      createdAt: resultMessage.createdAt,
      source: resultMessage.source,
      audience: resultMessage.audience,
      data: resultEncoding.data,
    };
    const messageEvent = createRunEventFactory().messageCommitted(
      cancelledRun,
      {
        messageId: resultDraft.messageId,
        conversationTurnId: resultDraft.conversationTurnId,
        messageType: "TOOL_RESULT",
      },
      createEventId(),
      createTimestampMs(150),
    );

    const closure = await storage.execution.commitInterruptedHistoryClosure({
      sessionId: session.id,
      runId: run.id,
      expectedAssistant: assistantRecord,
      toolCallId: "call_observed",
      toolName: "read_file",
      batchToolCallIds: ["call_observed"],
      callIndex: 0,
      closureVersion: 1,
      classification: "OBSERVATION_COMMITTED",
      missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED",
      message: resultDraft,
      messageEvent,
    });

    expect(closure.kind).toBe("APPENDED");
    expect(
      (await storage.messageRecords.listByRun(run.id)).map((record) => record.messageType),
    ).toEqual(["ASSISTANT", "TOOL_RESULT"]);
    expect(
      (await storage.toolExecution.findByExternalCall(run.id, step.id, "call_observed"))
        ?.observation,
    ).toEqual(observation);
    expect((await storage.runs.get(run.id))?.status).toBe("CANCELLED");
    await storage.close();
  });

  it("rolls back a result if its paired durable event is invalid", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "CANCELLED",
      finishedAt: createTimestampMs(130),
    });
    const step = makeStep(run.id, {
      status: "COMPLETED",
      finishedAt: createTimestampMs(120),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    const factory = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory(["amsg_0192f5b1-4d3a-7c2e-8a91-000000000102"]),
      now: () => createTimestampMs(120),
      turns,
    });
    const assistant = factory.createAssistant({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: modelMessageSource("llm_interrupted_2"),
      phase: "COMMENTARY",
      content: [
        { type: "TOOL_CALL", toolCallId: "call_a", toolName: "read_file", input: { path: "a" } },
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_interrupted_2",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const encoded = codecs.encode(assistant);
    const [assistantRecord] = await storage.messageRecords.append(run.id, [
      {
        messageId: assistant.id,
        sessionId: session.id,
        conversationTurnId: assistant.conversationTurnId,
        messageType: assistant.type,
        schemaVersion: encoded.schemaVersion,
        modelProjectionVersion: encoded.modelProjectionVersion,
        sourceStepId: step.id,
        createdAt: assistant.createdAt,
        source: assistant.source,
        audience: assistant.audience,
        data: encoded.data,
      },
    ]);
    if (assistantRecord === undefined) throw new Error("assistant fixture did not persist");

    const messageId = deriveInterruptedToolResultMessageId({
      sessionId: session.id,
      sourceRunId: run.id,
      assistantMessageId: assistant.id,
      toolCallId: "call_a",
      closureVersion: 1,
    });
    const resultFactory = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory([messageId]),
      now: () => createTimestampMs(140),
      turns,
    });
    const resultMessage = resultFactory.createToolResult({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: toolMessageSource(),
      toolCallId: "call_a",
      toolName: "read_file",
      observation: NO_TOOL_RESULT_OBSERVATION,
      isError: false,
      projectedContent:
        "The tool call was not started because the previous run was interrupted. It may be requested again if still needed.",
      projection: {
        policy: toolFeedbackPolicySnapshot({
          maxSingleObservationTokens: 1000,
          maxObservationBatchTokens: 4000,
        }),
        fingerprint: "closure-fingerprint",
        version: 1,
      },
    });
    const resultEncoding = codecs.encode(resultMessage);
    const eventFactory = createRunEventFactory();
    const validEvent = eventFactory.messageCommitted(
      run,
      {
        messageId: resultMessage.id,
        conversationTurnId: resultMessage.conversationTurnId,
        messageType: "TOOL_RESULT",
      },
      createEventId(),
      createTimestampMs(140),
    );
    const command = {
      sessionId: session.id,
      runId: run.id,
      expectedAssistant: assistantRecord,
      toolCallId: "call_a",
      toolName: "read_file",
      batchToolCallIds: ["call_a"],
      callIndex: 0,
      closureVersion: 1,
      classification: "NOT_STARTED" as const,
      missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED" as const,
      message: {
        messageId: resultMessage.id,
        sessionId: session.id,
        conversationTurnId: resultMessage.conversationTurnId,
        messageType: resultMessage.type,
        schemaVersion: resultEncoding.schemaVersion,
        modelProjectionVersion: resultEncoding.modelProjectionVersion,
        sourceStepId: step.id,
        createdAt: resultMessage.createdAt,
        source: resultMessage.source,
        audience: resultMessage.audience,
        data: resultEncoding.data,
      },
      messageEvent: { ...validEvent, visibility: "INVALID" } as typeof validEvent,
    };

    await expect(storage.execution.commitInterruptedHistoryClosure(command)).rejects.toThrow();
    expect(
      (await storage.messageRecords.listByRun(run.id)).map((record) => record.messageType),
    ).toEqual(["ASSISTANT"]);
    expect(await storage.eventReader.latestSequence(run.id)).toBe(0);
    await storage.close();
  });
});
