import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import type { ContextUsageSnapshot } from "@caelush/agent";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("SqliteContextUsageStore", () => {
  it("round-trips V2 source breakdown and all build statuses through the legacy table", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const runId = createRunId();
    const sessionId = createSessionId();
    const run = AgentRunSchema.parse({
      id: runId,
      sessionId,
      goal: "Phase 7E usage",
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
    await storage.sessions.insert({ id: sessionId, createdAt: run.createdAt, updatedAt: run.createdAt, metadata: {} });
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
      breakdown: [
        { sourceId: "agent.conversation", tokens: 200, itemCount: 3 },
        { sourceId: "coding.relevant-files", tokens: 200, itemCount: 2 },
      ],
      lastBuildStatus: "SUCCESS",
      contextFingerprint: "sha256:usage" as never,
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
});
