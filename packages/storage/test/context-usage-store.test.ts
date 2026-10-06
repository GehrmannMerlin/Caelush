import { createRunId, createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import type { ContextUsageSnapshot } from "@caelush/agent";
import { SqliteContextUsageStore } from "../src/context-usage-store.js";
import type { CaelushDatabase } from "../src/database.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("SqliteContextUsageStore", () => {
  it("round-trips V2 source breakdown and all build statuses through the legacy table", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const session = makeSession({
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
    });
    const run = makeRun(session.id, {
      goal: "Phase 7E usage",
      createdAt: createTimestampMs(1),
    });
    const runId = run.id;
    await storage.sessions.insert({
      id: session.id,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      metadata: {},
    });
    await storage.runs.insert(run);
    const snapshot: ContextUsageSnapshot = {
      runId,
      modelRef: { provider: "fixture", model: "fixture" },
      contextWindowTokens: 1000,
      effectiveInputLimitTokens: 800,
      estimatedInputTokens: 400,
      remainingTokens: 400,
      pressureState: "PROACTIVE",
      compactionCount: 2,
      lastCompactionAt: createTimestampMs(20),
      lastRecoveryStages: [],
      breakdown: [
        { sourceId: "agent.conversation", tokens: 200, itemCount: 3 },
        { sourceId: "coding.relevant-files", tokens: 200, itemCount: 2 },
      ],
      lastBuildStatus: "SUCCESS",
      contextFingerprint: "sha256:usage" as never,
      promptSurface: {
        epochId: "epoch-usage",
        prefixFingerprint: `sha256:${"a".repeat(64)}`,
        stableHeadTokens: 100,
        snapshotTokens: 50,
        expectedReusablePrefixTokens: 150,
        resetReason: "INITIAL",
      },
      updatedAt: createTimestampMs(21),
    };

    await storage.contextUsage.upsert(snapshot);
    await expect(storage.contextUsage.getByRun(runId)).resolves.toEqual(snapshot);

    for (const status of ["FAILED", "CONTEXT_EXHAUSTED"] as const) {
      await storage.contextUsage.upsert({ ...snapshot, lastBuildStatus: status });
      await expect(storage.contextUsage.getByRun(runId)).resolves.toMatchObject({
        lastBuildStatus: status,
        breakdown: snapshot.breakdown,
      });
    }
  });

  it("decodes the legacy V2 envelope without inventing Prompt Surface diagnostics", async () => {
    const runId = createRunId();
    const row = {
      run_id: runId,
      provider_id: "fixture",
      model_id: "fixture-model",
      context_window_tokens: 1000,
      effective_input_limit_tokens: 800,
      estimated_input_tokens: 300,
      remaining_tokens: 500,
      pressure_state: "NORMAL",
      compaction_count: 0,
      last_compaction_at_ms: null,
      breakdown_json: JSON.stringify({
        version: 2,
        breakdown: [{ sourceId: "agent.conversation", tokens: 300, itemCount: 2 }],
        contextFingerprint: "sha256:legacy-usage",
      }),
      last_build_status: "SUCCESS",
      last_build_at_ms: 20,
      last_recovery_stages_json: "[]",
      updated_at_ms: 21,
    };
    const database = {
      client: {
        prepare() {
          return { get: () => row };
        },
      },
    } as unknown as CaelushDatabase;
    const store = new SqliteContextUsageStore(database);

    await expect(store.getByRun(runId)).resolves.toMatchObject({
      runId,
      breakdown: [{ sourceId: "agent.conversation", tokens: 300, itemCount: 2 }],
      contextFingerprint: "sha256:legacy-usage",
    });
    await expect(store.getByRun(runId)).resolves.not.toHaveProperty("promptSurface");
  });
});
