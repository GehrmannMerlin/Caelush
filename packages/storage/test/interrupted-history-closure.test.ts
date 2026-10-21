import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEventId,
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type { AgentRun, AgentSession, AgentStep } from "@caelush/protocol";
import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
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
import type { AgentMessageRecord, AgentMessageRecordDraft } from "@caelush/agent";
import { isTerminalRunStatus } from "@caelush/core";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));
let restartTestDirectory: string | undefined;
let restartTestStorage: Awaited<ReturnType<typeof openCaelushStorage>> | undefined;

afterEach(async () => {
  await restartTestStorage?.close();
  restartTestStorage = undefined;
  if (restartTestDirectory !== undefined) {
    await rm(restartTestDirectory, { recursive: true, force: true });
    restartTestDirectory = undefined;
  }
});

describe("interrupted Tool history closure", () => {
  it("atomically appends one ordered result and metadata event without reopening the Run", async () => {
    restartTestDirectory = await mkdtemp(join(tmpdir(), "caelush-interrupted-closure-"));
    const databasePath = join(restartTestDirectory, "closure.db");
    let storage = await openCaelushStorage({ path: databasePath });
    restartTestStorage = storage;
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
    await storage.close();
    restartTestStorage = undefined;
    storage = await openCaelushStorage({ path: databasePath });
    restartTestStorage = storage;
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
    restartTestStorage = undefined;
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

/* ------------------------------------------------------------------------------------------------
 * FAILED Runs are eligible for the same closure, and nothing else grew with them
 * ---------------------------------------------------------------------------------------------- */

type ClosureCommand = Parameters<CaelushStorage["execution"]["commitInterruptedHistoryClosure"]>[0];

const FAILED_SUITE_CLOSURE_VERSION = 1;

interface SeededRun {
  readonly session: AgentSession;
  readonly run: AgentRun;
  readonly step: AgentStep;
  readonly assistantRecord: AgentMessageRecord;
  readonly callIds: readonly string[];
}

/**
 * Seed a Run whose Assistant message has unanswered Tool calls.
 *
 * The gap is created directly as durable fact rather than by reproducing a product bug, so the test
 * keeps meaning the same thing after the bug is fixed.
 */
async function seedInterruptedRun(
  storage: CaelushStorage,
  options: {
    readonly status: AgentRun["status"];
    readonly callIds?: readonly string[];
    readonly stepStatus?: AgentStep["status"];
  },
): Promise<SeededRun> {
  const callIds = options.callIds ?? ["call_failed"];
  const terminal = options.status !== "RUNNING" && options.status !== "PENDING";
  const session = makeSession();
  const run = makeRun(session.id, {
    status: options.status,
    ...(terminal ? { finishedAt: createTimestampMs(200) } : { startedAt: createTimestampMs(100) }),
  });
  const step = makeStep(run.id, {
    status: options.stepStatus ?? (terminal ? "FAILED" : "RUNNING"),
    finishedAt: createTimestampMs(150),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  await storage.steps.insert(step);

  const assistant = createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => createTimestampMs(140),
    turns,
  }).createAssistant({
    runId: run.id,
    sessionId: session.id,
    conversationTurnId: turns.forRun(run.id),
    sourceStepId: step.id,
    source: modelMessageSource("llm_failed_history"),
    phase: "COMMENTARY",
    content: callIds.map((toolCallId) => ({
      type: "TOOL_CALL" as const,
      toolCallId,
      toolName: "read_file" as const,
      input: { path: `${toolCallId}.txt` },
    })),
    model: {
      kind: "MODEL_TURN",
      callId: "llm_failed_history",
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
  return { session, run, step, assistantRecord, callIds };
}

async function closureCommandFor(
  seeded: SeededRun,
  callIndex: number,
  options: {
    readonly classification?: ClosureCommand["classification"];
    readonly expectedRunStatus?: "CANCELLED" | "FAILED";
    readonly projectedContent?: string;
  } = {},
): Promise<ClosureCommand> {
  const toolCallId = seeded.callIds[callIndex]!;
  const classification = options.classification ?? "NOT_STARTED";
  const messageId = deriveInterruptedToolResultMessageId({
    sessionId: seeded.session.id,
    sourceRunId: seeded.run.id,
    assistantMessageId: seeded.assistantRecord.messageId,
    toolCallId,
    closureVersion: FAILED_SUITE_CLOSURE_VERSION,
  });
  const now = seeded.run.finishedAt ?? seeded.assistantRecord.createdAt;
  const resultMessage = createAgentMessageFactory({
    ids: createScriptedAgentMessageIdFactory([messageId]),
    now: () => now,
    turns,
  }).createToolResult({
    runId: seeded.run.id,
    sessionId: seeded.session.id,
    conversationTurnId: seeded.assistantRecord.conversationTurnId,
    sourceStepId: seeded.step.id,
    source: toolMessageSource(),
    toolCallId,
    toolName: "read_file",
    observation: NO_TOOL_RESULT_OBSERVATION,
    isError: false,
    projectedContent:
      options.projectedContent ??
      "The tool call was not started because the previous run was interrupted. It may be requested again if still needed.",
    projection: {
      policy: toolFeedbackPolicySnapshot({
        maxSingleObservationTokens: 1000,
        maxObservationBatchTokens: 4000,
      }),
      fingerprint: "failed-history-fingerprint",
      version: 1,
    },
  });
  const encoded = codecs.encode(resultMessage);
  const draft: AgentMessageRecordDraft = {
    messageId: resultMessage.id,
    sessionId: resultMessage.sessionId,
    conversationTurnId: resultMessage.conversationTurnId,
    messageType: resultMessage.type,
    schemaVersion: encoded.schemaVersion,
    modelProjectionVersion: encoded.modelProjectionVersion,
    sourceStepId: seeded.step.id,
    createdAt: resultMessage.createdAt,
    source: resultMessage.source,
    audience: resultMessage.audience,
    data: encoded.data,
  };
  const messageEvent = createRunEventFactory().messageCommitted(
    seeded.run,
    {
      messageId: draft.messageId,
      conversationTurnId: draft.conversationTurnId,
      messageType: "TOOL_RESULT",
    },
    createEventId(),
    now,
  );
  return {
    sessionId: seeded.session.id,
    runId: seeded.run.id,
    expectedAssistant: seeded.assistantRecord,
    toolCallId,
    toolName: "read_file",
    batchToolCallIds: seeded.callIds,
    callIndex,
    closureVersion: FAILED_SUITE_CLOSURE_VERSION,
    classification,
    missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED",
    message: draft,
    messageEvent,
    ...(options.expectedRunStatus === undefined
      ? {}
      : { expectedRunStatus: options.expectedRunStatus }),
  };
}

describe("interrupted Tool history closure for a FAILED Run", () => {
  it("appends the missing result when the caller states FAILED", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const seeded = await seedInterruptedRun(storage, { status: "FAILED" });

    const command = await closureCommandFor(seeded, 0, { expectedRunStatus: "FAILED" });
    const first = await storage.execution.commitInterruptedHistoryClosure(command);
    const retry = await storage.execution.commitInterruptedHistoryClosure(command);

    expect(first.kind).toBe("APPENDED");
    expect(first.events.map((event) => event.type)).toEqual(["conversation.message.committed"]);
    expect(retry.kind).toBe("ALREADY_PRESENT");
    expect(retry.events).toEqual([]);
    expect(
      (await storage.messageRecords.listByRun(seeded.run.id)).map((record) => record.messageType),
    ).toEqual(["ASSISTANT", "TOOL_RESULT"]);
    expect(await storage.eventReader.latestSequence(seeded.run.id)).toBe(1);
    // The Run is not revived: its terminal status is the same durable fact it was.
    expect((await storage.runs.get(seeded.run.id))?.status).toBe("FAILED");
    await storage.close();
  });

  it("still requires CANCELLED when the caller states no status", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const failed = await seedInterruptedRun(storage, { status: "FAILED" });

    await expect(
      storage.execution.commitInterruptedHistoryClosure(await closureCommandFor(failed, 0)),
    ).rejects.toThrow();
    expect(
      (await storage.messageRecords.listByRun(failed.run.id)).map((record) => record.messageType),
    ).toEqual(["ASSISTANT"]);
    await storage.close();
  });

  it("refuses a stated status that disagrees with the durable Run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const cancelled = await seedInterruptedRun(storage, { status: "CANCELLED" });
    const failed = await seedInterruptedRun(storage, { status: "FAILED" });
    const running = await seedInterruptedRun(storage, { status: "RUNNING" });

    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(cancelled, 0, { expectedRunStatus: "FAILED" }),
      ),
    ).rejects.toThrow();
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(failed, 0, { expectedRunStatus: "CANCELLED" }),
      ),
    ).rejects.toThrow();
    // A FAILED claim cannot be used to close a Run that is still executing.
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(running, 0, { expectedRunStatus: "FAILED" }),
      ),
    ).rejects.toThrow();
    await storage.close();
  });

  it("keeps the batch order rules for a FAILED Run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const seeded = await seedInterruptedRun(storage, {
      status: "FAILED",
      callIds: ["call_a", "call_b", "call_c"],
    });

    // A later call cannot be closed while an earlier one is still missing.
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 1, { expectedRunStatus: "FAILED" }),
      ),
    ).rejects.toThrow();
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 2, { expectedRunStatus: "FAILED" }),
      ),
    ).rejects.toThrow();

    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 0, { expectedRunStatus: "FAILED" }),
      ),
    ).resolves.toMatchObject({ kind: "APPENDED" });
    // Index 2 is still out of order now that index 1 is missing again.
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 2, { expectedRunStatus: "FAILED" }),
      ),
    ).rejects.toThrow();
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 1, { expectedRunStatus: "FAILED" }),
      ),
    ).resolves.toMatchObject({ kind: "APPENDED" });
    await expect(
      storage.execution.commitInterruptedHistoryClosure(
        await closureCommandFor(seeded, 2, { expectedRunStatus: "FAILED" }),
      ),
    ).resolves.toMatchObject({ kind: "APPENDED" });

    const records = await storage.messageRecords.listByRun(seeded.run.id);
    expect(records.map((record) => record.messageType)).toEqual([
      "ASSISTANT",
      "TOOL_RESULT",
      "TOOL_RESULT",
      "TOOL_RESULT",
    ]);
    expect(records.slice(1).map((record) => record.data["toolCallId"])).toEqual([
      "call_a",
      "call_b",
      "call_c",
    ]);
    await storage.close();
  });

  it("is idempotent under concurrent closure of the same FAILED gap", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const seeded = await seedInterruptedRun(storage, { status: "FAILED" });
    const command = await closureCommandFor(seeded, 0, { expectedRunStatus: "FAILED" });

    const results = await Promise.all([
      storage.execution.commitInterruptedHistoryClosure(command),
      storage.execution.commitInterruptedHistoryClosure(command),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["ALREADY_PRESENT", "APPENDED"]);
    expect(await storage.eventReader.latestSequence(seeded.run.id)).toBe(1);
    expect(await storage.messageRecords.listByRun(seeded.run.id)).toHaveLength(2);
    await storage.close();
  });

  it("refuses a FAILED closure inside an archived Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-failed-closure-"));
    const path = join(root, "archived.db");
    const storage = await openCaelushStorage({ path, archivePolicy: { isTerminalRunStatus } });
    try {
      const seeded = await seedInterruptedRun(storage, { status: "FAILED" });
      await storage.archives.archive(
        { type: "SESSION", sessionId: seeded.session.id },
        createTimestampMs(210),
      );

      await expect(
        storage.execution.commitInterruptedHistoryClosure(
          await closureCommandFor(seeded, 0, { expectedRunStatus: "FAILED" }),
        ),
      ).rejects.toThrow();
      expect(await storage.messageRecords.listByRun(seeded.run.id)).toHaveLength(1);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to close a call that belongs to a different Assistant message", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const seeded = await seedInterruptedRun(storage, { status: "FAILED" });
    const other = await seedInterruptedRun(storage, { status: "FAILED" });
    const command = await closureCommandFor(seeded, 0, { expectedRunStatus: "FAILED" });

    await expect(
      storage.execution.commitInterruptedHistoryClosure({
        ...command,
        expectedAssistant: other.assistantRecord,
      }),
    ).rejects.toThrow();
    expect(await storage.messageRecords.listByRun(seeded.run.id)).toHaveLength(1);
    await storage.close();
  });
});
