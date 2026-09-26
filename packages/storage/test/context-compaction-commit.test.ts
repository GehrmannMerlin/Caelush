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
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
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
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
    startedAt: createTimestampMs(2),
  });
  await storage.sessions.insert({ id: run.sessionId, createdAt: run.createdAt, updatedAt: run.createdAt, metadata: {} });
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
    await expect(storage.contextCheckpointsV2.getById(invalid.checkpointId)).resolves.toBeUndefined();
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
      storage.contextCompactionCommit.commit({ checkpoint: input, events: [event(other.id, other.sessionId)] }),
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
    await expect(storage.contextCheckpointsV2.getById(successInput.checkpointId)).resolves.toMatchObject({
      checkpointId: successInput.checkpointId,
    });
  });
});
