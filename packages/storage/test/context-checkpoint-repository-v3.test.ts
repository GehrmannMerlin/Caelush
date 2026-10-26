import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentConversationSnapshot,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createContextCheckpointId,
  createContextMessageRange,
  createContextSourceCoverage,
  createContextSummaryPromptVersion,
  beginPersistedCompactionAttempt,
  createConversationTurn,
  createPersistedCompactionAttemptTerminalArtifact,
  createDeterministicConversationTurnIdFactory,
  createPromptSurfaceAnchor,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceRecord,
  createPromptSurfaceSectionStates,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  createStructuredCheckpointV2,
} from "@caelush/agent";
import type {
  AgentMessage,
  AgentMessageRecordDraft,
  AgentConversationSnapshot,
  ContextCheckpointCreateInputV3,
  ContextSourceCoverage,
  StoredAgentMessage,
} from "@caelush/agent";
import {
  createEventId,
  createRunId,
  createTimestampMs,
  type AgentRun,
  type SessionId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { writeContextCheckpointV3InTransaction } from "../src/context-checkpoint-repository-v3.js";
import type { PromptSurfaceCompactionActivationCommand } from "@caelush/agent";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

const storages: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
const messageProjectors = createStandardAgentMessageProjectorRegistry();
const messageCodecs = createStandardAgentMessageCodecRegistry((type) =>
  messageProjectors.currentVersion(type),
);

afterEach(async () => {
  for (const storage of storages.splice(0)) await storage.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeMessageFactory() {
  return createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => createTimestampMs(100),
    turns: createDeterministicConversationTurnIdFactory(),
  });
}

function storedUser(run: AgentRun, sessionId: SessionId, sequence = 1): StoredAgentMessage {
  const turns = createDeterministicConversationTurnIdFactory();
  return {
    sequence,
    schemaVersion: 1,
    modelProjectionVersion: 1,
    message: makeMessageFactory().createUser({
      runId: run.id,
      sessionId,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: `source ${String(run.id)}` }],
    }),
  };
}

function sourceCoverageWithConversation(input: {
  readonly sessionId: SessionId;
  readonly sourceRuns: readonly AgentRun[];
  readonly ownerRun: AgentRun;
}): {
  readonly coverage: ContextSourceCoverage;
  readonly conversation: ReturnType<typeof createAgentConversationSnapshot>;
} {
  const messages = [...input.sourceRuns, input.ownerRun].map((run) =>
    storedUser(run, input.sessionId),
  );
  const turns = [...input.sourceRuns, input.ownerRun].map((run, index) =>
    createConversationTurn({
      id: createDeterministicConversationTurnIdFactory().forRun(run.id),
      sessionId: input.sessionId,
      runId: run.id,
      status: index === input.sourceRuns.length ? "OPEN" : "CLOSED",
      openedAt: run.createdAt,
      ...(index === input.sourceRuns.length
        ? {}
        : { closedAt: createTimestampMs(run.createdAt + 1) }),
      messages: [messages[index]!],
    }),
  );
  const conversation = createAgentConversationSnapshot({
    sessionId: input.sessionId,
    currentRunId: input.ownerRun.id,
    currentTurnId: createDeterministicConversationTurnIdFactory().forRun(input.ownerRun.id),
    turns,
  });
  const segments = messages.slice(0, input.sourceRuns.length).map((stored) =>
    createContextMessageRange({
      runId: stored.message.runId,
      conversationTurnId: stored.message.conversationTurnId,
      firstMessageId: stored.message.id,
      lastMessageId: stored.message.id,
      firstSequence: 1,
      lastSequence: 1,
    }),
  );
  return {
    coverage: createContextSourceCoverage({ sessionId: input.sessionId, conversation, segments }),
    conversation,
  };
}

async function persistConversation(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  conversation: AgentConversationSnapshot,
): Promise<void> {
  for (const turn of conversation.turns) {
    if (turn.messages.length === 0) continue;
    await storage.messageRecords.append(
      turn.runId,
      turn.messages.map((stored) => messageRecordDraft(stored.message)),
    );
  }
}

async function persistUnactivatedCheckpointForReadTest(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  input: ContextCheckpointCreateInputV3,
) {
  const database = storage.messageRecords.database;
  database.client.exec("BEGIN IMMEDIATE");
  try {
    writeContextCheckpointV3InTransaction(database, input);
    database.client.exec("COMMIT");
  } catch (error) {
    database.client.exec("ROLLBACK");
    throw error;
  }
  const checkpoint = await storage.contextCheckpointsV3.getById(input.checkpointId);
  if (checkpoint === undefined) throw new Error("V3 read-test checkpoint was not persisted");
  return checkpoint;
}

function messageRecordDraft(message: AgentMessage): AgentMessageRecordDraft {
  const encoded = messageCodecs.encode(message);
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: encoded.schemaVersion,
    ...(encoded.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: encoded.modelProjectionVersion }),
    ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data: encoded.data,
  };
}

function checkpoint(input: {
  readonly ownerRun: AgentRun;
  readonly sessionId: SessionId;
  readonly coverage: ContextSourceCoverage;
  readonly stepSequence: number;
  readonly id: string;
  readonly previousCheckpointId?: string;
  readonly createdAt: number;
}): ContextCheckpointCreateInputV3 {
  return {
    checkpointId: createContextCheckpointId(input.id),
    ownerRunId: input.ownerRun.id,
    ownerStepSequence: input.stepSequence,
    sessionId: input.sessionId,
    ...(input.previousCheckpointId === undefined
      ? {}
      : { previousCheckpointId: createContextCheckpointId(input.previousCheckpointId) }),
    activationOperationId: `operation:${input.id}`,
    coverage: input.coverage,
    structuredCheckpoint: createStructuredCheckpointV2({
      version: 2,
      goal: "current host-owned goal",
      constraints: [],
      completedWork: ["preserved"],
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
      sourceCoverage: input.coverage,
    }),
    tokensBefore: 930_000,
    tokensAfter: 44_192,
    modelRef: input.ownerRun.model,
    summaryPromptVersion: createContextSummaryPromptVersion(4),
    sourceDigest: "a".repeat(64),
    checkpointDigest: "b".repeat(64),
    degraded: false,
    reason: "PROACTIVE_PRESSURE",
    targetStatus: "PREFERRED",
    createdAt: createTimestampMs(input.createdAt),
  };
}

describe("SqliteContextCheckpointRepositoryV3", () => {
  it("accepts the next pending owner Step but rejects a skipped owner Step", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    storages.push(storage);
    const session = makeSession();
    const sourceRun = makeRun(session.id, {
      id: createRunId(),
      status: "COMPLETED",
      createdAt: createTimestampMs(10),
      startedAt: createTimestampMs(11),
      finishedAt: createTimestampMs(12),
    });
    const ownerRun = makeRun(session.id, {
      id: createRunId(),
      status: "RUNNING",
      createdAt: createTimestampMs(20),
      startedAt: createTimestampMs(21),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(sourceRun);
    await storage.runs.insert(ownerRun);
    await storage.steps.insert(makeStep(ownerRun.id, { sequence: 1 }));
    const source = sourceCoverageWithConversation({
      sessionId: session.id,
      sourceRuns: [sourceRun],
      ownerRun,
    });
    await persistConversation(storage, source.conversation);

    const pending = checkpoint({
      ownerRun,
      sessionId: session.id,
      coverage: source.coverage,
      stepSequence: 2,
      id: "checkpoint:v3:pending-step",
      createdAt: 30,
    });
    await expect(persistUnactivatedCheckpointForReadTest(storage, pending)).resolves.toMatchObject({
      ownerStepSequence: 2,
    });

    const skipped = checkpoint({
      ownerRun,
      sessionId: session.id,
      coverage: source.coverage,
      stepSequence: 3,
      id: "checkpoint:v3:skipped-step",
      createdAt: 31,
    });
    await expect(persistUnactivatedCheckpointForReadTest(storage, skipped)).rejects.toThrow(
      "Context Checkpoint V3 owner Step is unavailable.",
    );
  });

  it("persists multi-Run coverage with local sequence columns NULL and pages by Session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-checkpoint-v3-repo-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    storages.push(storage);
    const session = makeSession();
    const sourceA = makeRun(session.id, {
      id: createRunId(),
      status: "COMPLETED",
      createdAt: createTimestampMs(10),
      startedAt: createTimestampMs(11),
      finishedAt: createTimestampMs(12),
    });
    const sourceB = makeRun(session.id, {
      id: createRunId(),
      status: "COMPLETED",
      createdAt: createTimestampMs(20),
      startedAt: createTimestampMs(21),
      finishedAt: createTimestampMs(22),
    });
    const ownerRun = makeRun(session.id, {
      id: createRunId(),
      status: "RUNNING",
      createdAt: createTimestampMs(30),
      startedAt: createTimestampMs(31),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(sourceA);
    await storage.runs.insert(sourceB);
    await storage.runs.insert(ownerRun);
    await storage.steps.insert(makeStep(ownerRun.id, { sequence: 1 }));
    await storage.steps.insert(makeStep(ownerRun.id, { sequence: 2 }));

    const source = sourceCoverageWithConversation({
      sessionId: session.id,
      sourceRuns: [sourceA, sourceB],
      ownerRun,
    });
    const coverage = source.coverage;
    await persistConversation(storage, source.conversation);
    const firstInput = checkpoint({
      ownerRun,
      sessionId: session.id,
      coverage,
      stepSequence: 1,
      id: "checkpoint:v3:first",
      createdAt: 40,
    });
    const first = await persistUnactivatedCheckpointForReadTest(storage, firstInput);
    const secondInput = checkpoint({
      ownerRun,
      sessionId: session.id,
      coverage,
      stepSequence: 2,
      id: "checkpoint:v3:second",
      previousCheckpointId: String(first.checkpointId),
      createdAt: 50,
    });
    const second = await persistUnactivatedCheckpointForReadTest(storage, secondInput);

    expect(second).toMatchObject({
      schemaVersion: 3,
      ownerRunId: ownerRun.id,
      sessionId: session.id,
      coverage: { messageCount: 2, segments: [{ firstSequence: 1 }, { firstSequence: 1 }] },
      structuredCheckpoint: {
        version: 2,
        sourceCoverage: { coverageDigest: coverage.coverageDigest },
      },
      previousCheckpointId: first.checkpointId,
    });
    const sqlite = new DatabaseSync(databasePath);
    try {
      expect(
        sqlite
          .prepare(
            "SELECT session_id, owner_step_sequence, activation_operation_id, source_sequence_from, source_sequence_to, coverage_digest FROM context_checkpoints WHERE id = ?",
          )
          .get(first.checkpointId),
      ).toMatchObject({
        session_id: session.id,
        owner_step_sequence: 1,
        activation_operation_id: "operation:checkpoint:v3:first",
        source_sequence_from: null,
        source_sequence_to: null,
        coverage_digest: coverage.coverageDigest,
      });
    } finally {
      sqlite.close();
    }

    const firstPage = await storage.contextCheckpointsV3.listCandidatesBySession({
      sessionId: session.id,
      throughRunId: ownerRun.id,
      limit: 1,
    });
    expect(firstPage.records.map((record) => record.checkpointId)).toEqual([second.checkpointId]);
    expect(firstPage.nextCursor).toBeTypeOf("string");
    const secondPage = await storage.contextCheckpointsV3.listCandidatesBySession({
      sessionId: session.id,
      throughRunId: ownerRun.id,
      ...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
      limit: 1,
    });
    expect(secondPage.records.map((record) => record.checkpointId)).toEqual([first.checkpointId]);
    expect(secondPage.nextCursor).toBeUndefined();
    await storage.close();
    storages.splice(storages.indexOf(storage), 1);
  });

  it("atomically activates a multi-Run V3 checkpoint with usage and a V3 completion proof", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    storages.push(storage);
    const session = makeSession();
    const sourceA = makeRun(session.id, {
      id: createRunId(),
      status: "COMPLETED",
      createdAt: createTimestampMs(10),
      startedAt: createTimestampMs(11),
      finishedAt: createTimestampMs(12),
    });
    const sourceB = makeRun(session.id, {
      id: createRunId(),
      status: "COMPLETED",
      createdAt: createTimestampMs(20),
      startedAt: createTimestampMs(21),
      finishedAt: createTimestampMs(22),
    });
    const ownerRun = makeRun(session.id, {
      id: createRunId(),
      status: "RUNNING",
      createdAt: createTimestampMs(30),
      startedAt: createTimestampMs(31),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(sourceA);
    await storage.runs.insert(sourceB);
    await storage.runs.insert(ownerRun);
    await storage.steps.insert(makeStep(ownerRun.id, { sequence: 1 }));

    const source = sourceCoverageWithConversation({
      sessionId: session.id,
      sourceRuns: [sourceA, sourceB],
      ownerRun,
    });
    const coverage = source.coverage;
    await persistConversation(storage, source.conversation);
    const checkpointInput = {
      ...checkpoint({
        ownerRun,
        sessionId: session.id,
        coverage,
        stepSequence: 1,
        id: "checkpoint:v3:atomic",
        createdAt: 40,
      }),
      targetStatus: "FLOOR_LIMITED" as const,
    };
    const epoch = createPromptSurfaceEpoch({
      formatVersion: 3,
      runId: ownerRun.id,
      epochId: createPromptSurfaceEpochId("epoch:v3:atomic"),
      modelRef: ownerRun.model,
      stableHeadFingerprint: `sha256:${"a".repeat(64)}`,
      toolSchemaFingerprint: `sha256:${"b".repeat(64)}`,
      cacheSettingsFingerprint: `sha256:${"c".repeat(64)}`,
      resetReason: "COMPACTION_COMMITTED",
      createdStepSequence: 1,
      createdAt: createTimestampMs(50),
    });
    const sectionStates = createPromptSurfaceSectionStates({ sections: [] });
    const activation: PromptSurfaceCompactionActivationCommand = {
      expectedCurrent: { kind: "ABSENT" },
      operationId: checkpointInput.activationOperationId,
      newEpoch: epoch,
      baseline: createPromptSurfaceRecord({
        runId: ownerRun.id,
        epochId: epoch.epochId,
        ordinal: 1,
        anchor: createPromptSurfaceAnchor({
          messageId: coverage.segments[0]!.firstMessageId,
          runId: coverage.segments[0]!.runId,
          conversationTurnId: coverage.segments[0]!.conversationTurnId,
          sequence: coverage.segments[0]!.firstSequence,
        }),
        sourceStepSequence: 1,
        kind: "BASELINE",
        updates: [],
        decisionFingerprint: "d".repeat(64),
        createdAt: createTimestampMs(50),
      }),
      expectedSectionStates: sectionStates,
    };
    const eventId = createEventId();
    const retention = {
      status: checkpointInput.targetStatus,
      preferredInputTokens: 44_192,
      protectedFloorInputTokens: 20_000,
      hardInputLimitTokens: 900_000,
      compressibleTokens: checkpointInput.tokensBefore - checkpointInput.tokensAfter,
      minimumReleaseRatio: 0.7,
      minimumReleaseTokens: 8_192,
      actualFreedTokens: checkpointInput.tokensBefore - checkpointInput.tokensAfter,
    } as const;
    const completion = {
      eventId,
      schemaVersion: 3 as const,
      runId: ownerRun.id,
      sessionId: session.id,
      timestamp: createTimestampMs(51),
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const },
      type: "context.compaction.completed" as const,
      payload: {
        checkpointId: String(checkpointInput.checkpointId),
        operationId: checkpointInput.activationOperationId,
        epochId: String(epoch.epochId),
        reason: checkpointInput.reason,
        sourceRangeCount: coverage.segments.length,
        sourceMessageCount: coverage.messageCount,
        tokensBefore: checkpointInput.tokensBefore,
        tokensAfter: checkpointInput.tokensAfter,
        freedTokens: checkpointInput.tokensBefore - checkpointInput.tokensAfter,
        degraded: checkpointInput.degraded,
        targetStatus: checkpointInput.targetStatus,
        retention,
      },
    };
    const usage = {
      runId: ownerRun.id,
      modelRef: ownerRun.model,
      contextWindowTokens: 1_000_000,
      effectiveInputLimitTokens: 900_000,
      estimatedInputTokens: checkpointInput.tokensAfter,
      remainingTokens: 900_000 - checkpointInput.tokensAfter,
      pressureState: "NORMAL" as const,
      compactionCount: 1,
      breakdown: [],
      lastBuildStatus: "SUCCESS" as const,
      lastCompactionRetention: retention,
      updatedAt: createTimestampMs(51),
    };
    const attemptClaim = await beginPersistedCompactionAttempt({
      store: storage.contextArtifactsV2,
      runId: ownerRun.id,
      sessionId: session.id,
      sourceCoverageDigest: "c".repeat(64),
      sourceTokens: 2,
      createdSequence: 1,
      createdAt: createTimestampMs(51),
    });
    if (attemptClaim.kind !== "CLAIMED") throw new Error("compaction attempt was not claimed");
    const terminalArtifact = createPersistedCompactionAttemptTerminalArtifact({
      attempt: attemptClaim.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(52),
      outcome: "COMPACTED",
      checkpointId: String(checkpointInput.checkpointId),
      activationOperationId: checkpointInput.activationOperationId,
    });

    const missingSource = source.conversation.turns.find((turn) => turn.runId === sourceB.id)
      ?.messages[0];
    if (missingSource === undefined) throw new Error("coverage source fixture is unavailable");
    storage.messageRecords.database.client
      .prepare("DELETE FROM agent_messages WHERE message_id = ?")
      .run(missingSource.message.id);
    await expect(
      storage.contextCompactionCommit.commitV3!({
        checkpoint: checkpointInput,
        events: [completion],
        terminalArtifact,
        activation: {
          promptSurface: activation,
          usage,
          targetStatus: checkpointInput.targetStatus,
        },
      }),
    ).rejects.toThrow("source coverage is incomplete");
    expect(
      storage.messageRecords.database.client
        .prepare("SELECT COUNT(*) AS count FROM context_checkpoints WHERE id = ?")
        .get(checkpointInput.checkpointId),
    ).toMatchObject({ count: 0 });
    await expect(storage.promptSurface.getCurrent(ownerRun.id)).resolves.toBeUndefined();
    await expect(storage.contextUsage.getByRun(ownerRun.id)).resolves.toBeUndefined();
    await expect(storage.eventReader.latestSequence(ownerRun.id)).resolves.toBe(0);
    await expect(
      storage.contextArtifactsV2.readInternal(terminalArtifact.artifactId!),
    ).resolves.toBeUndefined();
    await storage.messageRecords.append(sourceB.id, [messageRecordDraft(missingSource.message)]);

    const committed = await storage.contextCompactionCommit.commitV3!({
      checkpoint: checkpointInput,
      events: [completion],
      terminalArtifact,
      activation: { promptSurface: activation, usage, targetStatus: checkpointInput.targetStatus },
    });
    expect(committed.status).toBe("COMMITTED");
    expect(committed.checkpoint).toMatchObject({ schemaVersion: 3, coverage });
    expect(committed.events).toHaveLength(1);
    await expect(storage.contextUsage.getByRun(ownerRun.id)).resolves.toMatchObject({
      compactionCount: 1,
      estimatedInputTokens: checkpointInput.tokensAfter,
    });
    await expect(storage.promptSurface.getCurrent(ownerRun.id)).resolves.toMatchObject({
      epochId: epoch.epochId,
      resetReason: "COMPACTION_COMMITTED",
    });
    await expect(
      storage.contextCheckpointActivationReader.isActivated({
        checkpoint: committed.checkpoint,
        sessionId: source.conversation.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      storage.contextArtifactsV2.readInternal(terminalArtifact.artifactId!),
    ).resolves.toMatchObject({ content: expect.stringContaining('"state":"RESULT"') });

    const persistedCompletionRow = storage.messageRecords.database.client
      .prepare("SELECT data_json FROM agent_events WHERE event_id = ?")
      .get(eventId) as { readonly data_json: string } | undefined;
    if (persistedCompletionRow === undefined) throw new Error("completion event is unavailable");
    const persistedCompletion = JSON.parse(persistedCompletionRow.data_json) as {
      readonly payload: Record<string, unknown>;
      readonly [key: string]: unknown;
    };
    const { retention: _retention, ...legacyPayload } = persistedCompletion.payload;
    void _retention;
    const historicalCompletion = JSON.stringify({
      ...persistedCompletion,
      schemaVersion: 2,
      payload: legacyPayload,
    });
    storage.messageRecords.database.client
      .prepare("UPDATE agent_events SET event_schema_version = 2, data_json = ? WHERE event_id = ?")
      .run(historicalCompletion, eventId);

    const replayed = await storage.contextCompactionCommit.commitV3!({
      checkpoint: checkpointInput,
      events: [completion],
      terminalArtifact,
      activation: { promptSurface: activation, usage, targetStatus: checkpointInput.targetStatus },
    });
    expect(replayed.status).toBe("IDEMPOTENT");
    expect(replayed.events).toEqual([]);
    await expect(storage.eventReader.latestSequence(ownerRun.id)).resolves.toBe(1);
  });
});
