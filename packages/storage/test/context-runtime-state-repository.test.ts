import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("SqliteContextRuntimeStateRepository", () => {
  it("persists authoritative context telemetry and restores it after reopen", async () => {
    const databasePath = `file:context-runtime-state-${Date.now()}-${Math.random()}`;
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
});
