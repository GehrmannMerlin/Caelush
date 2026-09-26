import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createStructuredCheckpoint,
  conversationTurnId,
} from "@caelush/agent";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import type { ContextCheckpointCreateInputV2 } from "@caelush/agent";

const directories: string[] = [];
const storages: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) await storage.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeRun() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "persist Context Checkpoint V2",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
    startedAt: createTimestampMs(2),
  });
}

function checkpoint(
  runId: string,
  sourceFrom: number,
  sourceTo: number,
): ContextCheckpointCreateInputV2 {
  const turnId = conversationTurnId("cturn_storage_7d");
  const sourceRange = createContextMessageRange({
    runId,
    conversationTurnId: turnId,
    firstMessageId: `amsg_storage_first_${String(sourceFrom)}` as never,
    lastMessageId: `amsg_storage_last_${String(sourceTo)}` as never,
    firstSequence: sourceFrom,
    lastSequence: sourceTo,
  });
  return {
    checkpointId: createContextCheckpointId(`checkpoint:v2:${String(sourceFrom)}`),
    runId,
    sourceRange,
    structuredCheckpoint: createStructuredCheckpoint({
      version: 1,
      goal: "persist Context Checkpoint V2",
      constraints: [],
      completedWork: [],
      inProgress: ["storage"],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: ["reuse existing table"],
      changedFiles: ["packages/storage"],
      readFiles: [],
      recentErrors: [],
      verificationState: "not-run",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "bounded",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: sourceFrom, to: sourceTo },
    }),
    tokensBefore: 100,
    tokensAfter: 30,
    modelRef: { provider: "fixture", model: "fixture-model" },
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "source-digest",
    checkpointDigest: "checkpoint-digest",
    degraded: false,
    reason: "SELECTION_PRESSURE",
    createdAt: createTimestampMs(3),
  };
}

describe("SqliteContextCheckpointRepositoryV2", () => {
  it("reads legacy V1, writes immutable V2, and preserves mixed replay order", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-checkpoint-v2-"));
    directories.push(directory);
    const storage = await openCaelushStorage({ path: path.join(directory, "caelush.db") });
    storages.push(storage);
    const run = makeRun();
    await storage.sessions.insert({
      id: run.sessionId,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      metadata: {},
    });
    await storage.runs.insert(run);

    const legacyPayload = {
      version: 1 as const,
      goal: run.goal,
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "NONE",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: 1, to: 2 },
    };
    const legacy = await storage.contextCheckpoints.create({
      checkpointId: "checkpoint:v1",
      runId: run.id,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
      structuredCheckpoint: legacyPayload,
      tokensBefore: 120,
      tokensAfter: 40,
      modelRef: { providerId: "fixture", modelId: "fixture-model" },
      createdAt: createTimestampMs(4),
    });

    const v2Input = checkpoint(run.id, 3, 5);
    const v2 = await storage.contextCheckpointsV2.create(v2Input);
    const mixed = await storage.contextCheckpointsV2.listByRun(run.id);

    expect(legacy.schemaVersion).toBe(1);
    expect(v2).toMatchObject({
      checkpointId: v2Input.checkpointId,
      runId: run.id,
      schemaVersion: 2,
      sourceRange: { firstSequence: 3, lastSequence: 5 },
      structuredCheckpoint: { sourceRange: { from: 3, to: 5 } },
      modelRef: { provider: "fixture", model: "fixture-model" },
    });
    expect(mixed.map((record) => record.schemaVersion)).toEqual([1, 2]);
    await expect(
      storage.contextCheckpoints.updateTokensAfter(String(v2.checkpointId), 999),
    ).rejects.toThrow();
    await expect(
      storage.contextCheckpointsV2.getById(String(v2.checkpointId)),
    ).resolves.toMatchObject({
      tokensAfter: 30,
    });
    await expect(storage.contextCheckpointsV2.getById(legacy.checkpointId)).resolves.toMatchObject({
      schemaVersion: 1,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
    });
    await expect(storage.contextCheckpointsV2.getLatestByRun(run.id)).resolves.toMatchObject({
      schemaVersion: 2,
      checkpointId: v2Input.checkpointId,
    });
  });
});
