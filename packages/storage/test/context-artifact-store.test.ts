import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function addRun(storage: CaelushStorage) {
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "Phase 7E artifact",
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
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    metadata: {},
  });
  await storage.runs.insert(run);
  return run;
}

describe("SqliteContextArtifactStore", () => {
  it("uses run-scoped ids, rejects cross-run ownership, and reads legacy ids", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const firstRun = await addRun(storage);
    const secondRun = await addRun(storage);
    const input = {
      runId: firstRun.id,
      kind: "tool-output",
      sourceRef: "tool:exec",
      content: "same content",
      mimeType: "text/plain",
      sensitivity: "INTERNAL" as const,
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    };
    const firstArtifact = await storage.contextArtifactsV2.createOrGet(input);
    const sameArtifact = await storage.contextArtifactsV2.createOrGet(input);
    const secondArtifact = await storage.contextArtifactsV2.createOrGet({
      ...input,
      runId: secondRun.id,
    });

    expect(sameArtifact.artifactId).toBe(firstArtifact.artifactId);
    expect(secondArtifact.artifactId).not.toBe(firstArtifact.artifactId);
    await expect(
      storage.contextArtifactsV2.createOrGet({ ...input, artifactId: secondArtifact.artifactId }),
    ).rejects.toThrow();

    const legacy = await storage.contextArtifacts.createOrGet({
      artifactId: "artifact:legacy-id",
      ...input,
    });
    await expect(storage.contextArtifactsV2.readInternal(legacy.artifactId as never)).resolves.toMatchObject({
      artifactId: "artifact:legacy-id",
      runId: firstRun.id,
    });
  });

  it("keeps metadata content-free and applies a UTF-8 byte-safe projection", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const artifact = await storage.contextArtifactsV2.createOrGet({
      runId: run.id,
      kind: "tool-output",
      sourceRef: "tool:exec",
      content: "😀".repeat(100),
      mimeType: "text/plain",
      sensitivity: "SENSITIVE",
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    });
    const metadata = await storage.contextArtifactsV2.getMetadata(artifact.artifactId);
    const safe = await storage.contextArtifactsV2.readSafeProjection(artifact.artifactId, 32);

    expect(metadata).toBeDefined();
    expect(metadata).not.toHaveProperty("content");
    expect(metadata?.sensitivity).toBe("SENSITIVE");
    expect(Buffer.byteLength(safe ?? "", "utf8")).toBeLessThanOrEqual(32);
  });
});
