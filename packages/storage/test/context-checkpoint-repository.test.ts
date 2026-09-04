import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteContextCheckpointRepository } from "../src/context-checkpoint-repository.js";
import { StorageDecodeError } from "../src/errors.js";

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeRun() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "persist context",
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

describe("SqliteContextCheckpointRepository", () => {
  it("persists one latest checkpoint per source range and restores it after reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-checkpoint-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const first = await openCaelushStorage({ path: databasePath });
    const run = makeRun();
    await first.sessions.insert({
      id: run.sessionId,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      metadata: {},
    });
    await first.runs.insert(run);
    const checkpoint = {
      version: 1 as const,
      goal: run.goal,
      constraints: [],
      completedWork: ["baseline"],
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
    const record = await first.contextCheckpoints.create({
      checkpointId: "checkpoint:one",
      runId: run.id,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
      structuredCheckpoint: checkpoint,
      tokensBefore: 1200,
      tokensAfter: 400,
      modelRef: { providerId: run.model.provider, modelId: run.model.model },
      createdAt: createTimestampMs(3),
    });
    const duplicate = await first.contextCheckpoints.create({
      checkpointId: "checkpoint:duplicate",
      runId: run.id,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
      structuredCheckpoint: checkpoint,
      tokensBefore: 1200,
      tokensAfter: 400,
      modelRef: { providerId: run.model.provider, modelId: run.model.model },
      createdAt: createTimestampMs(4),
    });
    expect(duplicate.checkpointId).toBe(record.checkpointId);
    const refreshed = await first.contextCheckpoints.create({
      checkpointId: "checkpoint:refresh",
      runId: run.id,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 2,
      structuredCheckpoint: { ...checkpoint, changedFiles: ["src/app.ts"] },
      tokensBefore: 1400,
      tokensAfter: 450,
      modelRef: { providerId: run.model.provider, modelId: run.model.model },
      createdAt: createTimestampMs(5),
    });
    expect(refreshed.checkpointId).toBe(record.checkpointId);
    expect(refreshed.structuredCheckpoint.changedFiles).toEqual(["src/app.ts"]);
    await first.close();

    const second = await openCaelushStorage({ path: databasePath });
    await expect(second.contextCheckpoints.getLatestByRun(run.id)).resolves.toMatchObject({
      checkpointId: "checkpoint:one",
      schemaVersion: 1,
      sourceSequenceTo: 2,
      tokensAfter: 450,
      structuredCheckpoint: { changedFiles: ["src/app.ts"] },
    });
    await second.close();
  });

  it("fails closed with StorageDecodeError for malformed checkpoint JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-checkpoint-invalid-"));
    directories.push(directory);
    const database = await openCaelushDatabase({ path: path.join(directory, "caelush.db") });
    databases.push(database);
    await migrateCaelushDatabase(database);
    database.client.exec("PRAGMA foreign_keys = OFF");
    database.client
      .prepare(
        `INSERT INTO context_checkpoints
         (id, run_id, previous_checkpoint_id, source_sequence_from, source_sequence_to,
          tokens_before, tokens_after, summary_version, model_ref_json, created_at_ms,
          data_json, read_file_refs_json, changed_file_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "checkpoint:invalid",
        "run-invalid",
        null,
        1,
        2,
        10,
        5,
        1,
        '{"providerId":"fixture","modelId":"fixture-model"}',
        1,
        "{not-json}",
        "[]",
        "[]",
      );

    await expect(
      new SqliteContextCheckpointRepository(database).getById("checkpoint:invalid"),
    ).rejects.toBeInstanceOf(StorageDecodeError);
  });
});
