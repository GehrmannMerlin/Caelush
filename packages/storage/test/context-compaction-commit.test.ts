import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createStructuredCheckpoint,
  conversationTurnId,
  type ContextCheckpointCreateInputV2,
  type DurableRunEventDraft,
} from "@caelush/agent";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type RunId,
  type SessionId,
} from "@caelush/protocol";
import { StorageConflictError } from "../src/errors.js";
import { openCaelushDatabase } from "../src/database.js";
import { appendDurableEventsInTransaction } from "../src/events/sqlite-durable-event-store.js";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeSecurityPolicy } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function addRun(storage: CaelushStorage, runId: RunId = createRunId()) {
  const run = AgentRunSchema.parse({
    id: runId,
    sessionId: createSessionId(),
    goal: "Phase 7E compaction",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    securityPolicy: makeSecurityPolicy(),
    limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
    startedAt: createTimestampMs(2),
  });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    metadata: {},
  });
  await storage.runs.insert(run);
  return run;
}

function checkpoint(runId: RunId, id = "checkpoint:7e"): ContextCheckpointCreateInputV2 {
  const range = createContextMessageRange({
    runId,
    conversationTurnId: conversationTurnId("cturn_phase_7e"),
    firstMessageId: "amsg_phase_7e_first" as never,
    lastMessageId: "amsg_phase_7e_last" as never,
    firstSequence: 1,
    lastSequence: 2,
  });
  return {
    checkpointId: createContextCheckpointId(id),
    runId,
    sourceRange: range,
    structuredCheckpoint: createStructuredCheckpoint({
      version: 1,
      goal: "Phase 7E compaction",
      constraints: [],
      completedWork: [],
      inProgress: ["storage"],
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
      sourceRange: { from: 1, to: 2 },
    }),
    tokensBefore: 100,
    tokensAfter: 30,
    modelRef: { provider: "fixture", model: "fixture" },
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "source",
    checkpointDigest: "checkpoint",
    degraded: false,
    reason: "PROACTIVE_PRESSURE",
    createdAt: createTimestampMs(3),
  };
}

function event(runId: RunId, sessionId: SessionId): DurableRunEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(4),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "shell.output",
    payload: {
      invocationId: createToolInvocationId(),
      stream: "stdout",
      chunk: "compaction",
    },
  };
}

function completionEvent(
  runId: RunId,
  sessionId: SessionId,
  input: ContextCheckpointCreateInputV2,
  overrides: Partial<{
    readonly tokensAfter: number;
    readonly checkpointId: string;
  }> = {},
): DurableRunEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(5),
    visibility: "SYSTEM",
    durability: { kind: "DURABLE", version: 1 },
    type: "context.compaction.completed",
    payload: {
      checkpointId: overrides.checkpointId ?? String(input.checkpointId),
      reason: input.reason,
      sourceSequenceFrom: input.sourceRange.firstSequence,
      sourceSequenceTo: input.sourceRange.lastSequence,
      tokensBefore: input.tokensBefore,
      tokensAfter: overrides.tokensAfter ?? input.tokensAfter,
      degraded: input.degraded,
    },
  };
}

describe("SqliteContextCompactionCommitStore", () => {
  it("fails before writing when checkpoint validation fails", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const valid = checkpoint(run.id);
    const invalid = {
      ...valid,
      structuredCheckpoint: createStructuredCheckpoint({
        ...valid.structuredCheckpoint,
        sourceRange: { from: 2, to: 3 },
      }),
    };

    await expect(
      storage.contextCompactionCommit.commit({
        checkpoint: invalid,
        events: [event(run.id, run.sessionId)],
      }),
    ).rejects.toThrow();
    await expect(
      storage.contextCheckpointsV2.getById(invalid.checkpointId),
    ).resolves.toBeUndefined();
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(0);
  });

  it("rolls back checkpoint and event sequence when event append fails", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const bad = event(run.id, run.sessionId) as Record<string, unknown>;
    bad.payload = {};

    const input = checkpoint(run.id, "checkpoint:event-fails");
    await expect(
      storage.contextCompactionCommit.commit({ checkpoint: input, events: [bad as never] }),
    ).rejects.toThrow();
    await expect(storage.contextCheckpointsV2.getById(input.checkpointId)).resolves.toBeUndefined();
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(0);
  });

  it("rejects cross-run event ownership and commits checkpoint plus assigned event sequence together", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const other = await addRun(storage);
    const input = checkpoint(run.id, "checkpoint:ownership");
    await expect(
      storage.contextCompactionCommit.commit({
        checkpoint: input,
        events: [event(other.id, other.sessionId)],
      }),
    ).rejects.toThrow();
    await expect(storage.contextCheckpointsV2.getById(input.checkpointId)).resolves.toBeUndefined();
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(0);

    const successInput = checkpoint(run.id, "checkpoint:success");
    const committed = await storage.contextCompactionCommit.commit({
      checkpoint: successInput,
      events: [event(run.id, run.sessionId)],
    });
    expect(committed.checkpoint.checkpointId).toBe(successInput.checkpointId);
    expect(committed.events).toHaveLength(1);
    expect(committed.events[0]?.durability).toMatchObject({ kind: "DURABLE", sequence: 1 });
    await expect(
      storage.contextCheckpointsV2.getById(successInput.checkpointId),
    ).resolves.toMatchObject({
      checkpointId: successInput.checkpointId,
    });
  });

  it("replays an exact checkpoint commit without appending or notifying a second completion event", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const input = checkpoint(run.id, "checkpoint:replay");

    const first = await storage.contextCompactionCommit.commit({
      checkpoint: input,
      events: [completionEvent(run.id, run.sessionId, input)],
    });
    const replay = await storage.contextCompactionCommit.commit({
      checkpoint: input,
      events: [completionEvent(run.id, run.sessionId, input)],
    });

    expect(first.events).toHaveLength(1);
    expect(replay.checkpoint).toEqual(first.checkpoint);
    expect(replay.events).toEqual([]);
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(1);
    await expect(
      storage.eventReader.replay(run.id, { afterSequence: 0, throughSequence: 10, limit: 10 }),
    ).resolves.toHaveLength(1);
  });

  it("rejects a context completion event whose payload disagrees with the immutable checkpoint", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const input = checkpoint(run.id, "checkpoint:event-mismatch");

    await expect(
      storage.contextCompactionCommit.commit({
        checkpoint: input,
        events: [completionEvent(run.id, run.sessionId, input, { tokensAfter: 999 })],
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(storage.contextCheckpointsV2.getById(input.checkpointId)).resolves.toBeUndefined();
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(0);
  });

  it("fails closed when an identical checkpoint row has no provable completion event", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const input = checkpoint(run.id, "checkpoint:missing-proof");
    await storage.contextCheckpointsV2.create(input);

    await expect(
      storage.contextCompactionCommit.commit({
        checkpoint: input,
        events: [completionEvent(run.id, run.sessionId, input)],
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(storage.eventReader.latestSequence(run.id)).resolves.toBe(0);
  });

  it("fails closed when an identical checkpoint row has duplicate completion proof", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-commit-duplicate-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const firstStorage = await openCaelushStorage({ path: databasePath });
    const run = await addRun(firstStorage);
    const input = checkpoint(run.id, "checkpoint:duplicate-proof");
    await firstStorage.contextCompactionCommit.commit({
      checkpoint: input,
      events: [completionEvent(run.id, run.sessionId, input)],
    });
    await firstStorage.close();

    const database = await openCaelushDatabase({ path: databasePath });
    try {
      database.client.exec("BEGIN IMMEDIATE");
      appendDurableEventsInTransaction(database.client, [
        completionEvent(run.id, run.sessionId, input),
      ]);
      database.client.exec("COMMIT");
    } catch (error) {
      try {
        database.client.exec("ROLLBACK");
      } catch {
        // Preserve the original setup failure.
      }
      throw error;
    } finally {
      database.close();
    }

    const reopened = await openCaelushStorage({ path: databasePath });
    stores.push(reopened);
    await expect(
      reopened.contextCompactionCommit.commit({
        checkpoint: input,
        events: [completionEvent(run.id, run.sessionId, input)],
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(reopened.eventReader.latestSequence(run.id)).resolves.toBe(2);
  });

  it("replays the exact atomic commit after reopening without a second completion event", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-commit-restart-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const firstStorage = await openCaelushStorage({ path: databasePath });
    const run = await addRun(firstStorage);
    const input = checkpoint(run.id, "checkpoint:restart-replay");
    const first = await firstStorage.contextCompactionCommit.commit({
      checkpoint: input,
      events: [completionEvent(run.id, run.sessionId, input)],
    });
    await firstStorage.close();

    const reopened = await openCaelushStorage({ path: databasePath });
    stores.push(reopened);
    const replay = await reopened.contextCompactionCommit.commit({
      checkpoint: input,
      events: [completionEvent(run.id, run.sessionId, input)],
    });

    expect(replay.checkpoint).toEqual(first.checkpoint);
    expect(replay.events).toEqual([]);
    await expect(reopened.eventReader.latestSequence(run.id)).resolves.toBe(1);
    await expect(
      reopened.eventReader.replay(run.id, { afterSequence: 0, throughSequence: 10, limit: 10 }),
    ).resolves.toHaveLength(1);
  });
});
