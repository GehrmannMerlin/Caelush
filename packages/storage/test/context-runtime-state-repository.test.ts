import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteContextRuntimeStateRepository } from "../src/context-runtime-state-repository.js";
import { StorageDecodeError } from "../src/errors.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];
const temporaryDirectories: string[] = [];
const databases: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SqliteContextRuntimeStateRepository", () => {
  it("persists authoritative context telemetry and restores it after reopen", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-context-runtime-state-"));
    temporaryDirectories.push(temporaryDirectory);
    const databasePath = join(temporaryDirectory, "caelush.db");
    const first = await openCaelushStorage({ path: databasePath });
    stores.push(first);
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "inspect workspace",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: "/repo" },
      model: { provider: "fixture", model: "large" },
      runtime: { id: "local", kind: "fixture" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
      createdAt: createTimestampMs(1),
      startedAt: createTimestampMs(2),
    });
    await first.sessions.insert({
      id: run.sessionId,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      metadata: {},
    });
    await first.runs.insert(run);
    await first.contextRuntimeStates.upsert({
      runId: run.id,
      providerId: "fixture",
      modelId: "large",
      profileSource: "CONFIGURATION",
      contextWindowTokens: 32_000,
      rawContextWindowTokens: 40_000,
      effectiveInputLimitTokens: 28_000,
      estimatedInputTokens: 12_000,
      remainingTokens: 16_000,
      pressureState: "PROACTIVE",
      compactionCount: 2,
      lastCompactionAt: 20,
      lastBuildAt: 21,
      breakdown: {
        pinned: 1,
        checkpoint: 2,
        recentTail: 3,
        project: 4,
        files: 5,
        toolObservations: 6,
        memory: 7,
        systemTokens: 8,
        goalTokens: 9,
        currentUserTokens: 10,
        relevantFileTokens: 11,
        currentTurnTokens: 12,
        mandatoryTokens: 13,
      },
      lastRecoveryStages: ["REPROJECT_OBSERVATIONS", "REBUILD_CONTEXT"],
      lastBuildStatus: "SUCCESS",
      updatedAt: 22,
    });

    const restored = await first.contextRuntimeStates.getByRun(run.id);
    expect(restored).toMatchObject({
      rawContextWindowTokens: 40_000,
      lastBuildAt: 21,
      lastRecoveryStages: ["REPROJECT_OBSERVATIONS", "REBUILD_CONTEXT"],
      breakdown: { currentTurnTokens: 12, mandatoryTokens: 13 },
    });
  });

  it("fails closed with StorageDecodeError for malformed persisted telemetry", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-context-runtime-invalid-"));
    temporaryDirectories.push(temporaryDirectory);
    const database = await openCaelushDatabase({ path: join(temporaryDirectory, "caelush.db") });
    databases.push(database);
    await migrateCaelushDatabase(database);
    database.client.exec("PRAGMA foreign_keys = OFF");
    database.client
      .prepare(
        `INSERT INTO context_runtime_states
         (run_id, provider_id, model_id, profile_source, context_window_tokens,
          raw_context_window_tokens, effective_input_limit_tokens, estimated_input_tokens,
          remaining_tokens, pressure_state, compaction_count, last_compaction_at_ms,
          breakdown_json, last_build_status, last_build_at_ms, last_recovery_stages_json,
          updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "run-invalid",
        "fixture",
        "fixture-model",
        "CONFIGURATION",
        32_000,
        32_000,
        28_000,
        100,
        27_900,
        "NOT_A_PRESSURE_STATE",
        0,
        null,
        "{}",
        "SUCCESS",
        1,
        "[]",
        1,
      );

    await expect(
      new SqliteContextRuntimeStateRepository(database).getByRun("run-invalid"),
    ).rejects.toBeInstanceOf(StorageDecodeError);
  });
});
