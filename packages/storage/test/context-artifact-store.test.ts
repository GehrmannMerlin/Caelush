import { createSessionId, createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun as makeStorageRun } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function addRun(storage: CaelushStorage) {
  const run = makeStorageRun(createSessionId(), {
    goal: "Phase 7E artifact",
    status: "RUNNING",
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "fixture" },
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
  it("atomically claims an operation once and pages source records in stable ID order", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const base = {
      runId: run.id,
      kind: "context-compaction-attempt",
      sourceRef: "compaction-attempt:source-1",
      mimeType: "application/json",
      sensitivity: "INTERNAL" as const,
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    };
    const claims = await Promise.all([
      storage.contextArtifactsV2.claim({ ...base, content: "START:0" }),
      storage.contextArtifactsV2.claim({
        ...base,
        createdAt: createTimestampMs(4),
        content: "START:0",
      }),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(["CREATED", "EXISTING"]);
    expect(claims[0]?.artifact.artifactId).toBe(claims[1]?.artifact.artifactId);
    expect(claims[0]?.artifact.createdAt).toBe(createTimestampMs(3));
    expect(claims[1]?.artifact.createdAt).toBe(createTimestampMs(3));

    await Promise.all(
      ["START:1", "RESULT:0", "RESULT:1"].map((content) =>
        storage.contextArtifactsV2.claim({ ...base, content }),
      ),
    );
    await storage.contextArtifactsV2.claim({
      ...base,
      sourceRef: "compaction-attempt:other",
      content: "different source",
    });
    const first = await storage.contextArtifactsV2.listBySourceRef({
      kind: base.kind,
      sourceRef: base.sourceRef,
      limit: 2,
    });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await storage.contextArtifactsV2.listBySourceRef({
      kind: base.kind,
      sourceRef: base.sourceRef,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      limit: 2,
    });
    expect(second.records).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.records, ...second.records].map((item) => item.sourceRef))).toEqual(
      new Set([base.sourceRef]),
    );
  });

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
    await expect(
      storage.contextArtifactsV2.readInternal(legacy.artifactId as never),
    ).resolves.toMatchObject({
      artifactId: "artifact:legacy-id",
      runId: firstRun.id,
    });
  });

  it("reuses only bounded internal semantic summary artifacts across Runs", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const firstRun = await addRun(storage);
    const secondRun = await addRun(storage);
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const summary = {
      version: 1,
      requestFingerprint: fingerprint,
      promptVersion: 4,
      costVersion: "CONTEXT_SUMMARY_UTF8_V1",
      modelRef: { provider: "fixture", model: "fixture" },
      finishReason: "STOP",
      sourceDigest: "b".repeat(64),
      semanticDigest: "c".repeat(64),
      semantic: {
        constraints: ["preserve the requested behavior"],
        completedWork: [],
        inProgress: [],
        blocked: [],
        importantDiscoveries: [],
        keyDecisions: [],
        criticalReferences: [],
        nextIntent: "continue",
      },
    };
    const input = {
      artifactId: `artifact:compaction-summary:${"d".repeat(64)}` as never,
      runId: firstRun.id,
      kind: "context-compaction-summary",
      sourceRef: `compaction-summary:${fingerprint}`,
      content: JSON.stringify(summary),
      mimeType: "application/json",
      sensitivity: "INTERNAL" as const,
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    };

    const first = await storage.contextArtifactsV2.claim(input);
    const replay = await storage.contextArtifactsV2.claim({ ...input, runId: secondRun.id });

    expect(first.kind).toBe("CREATED");
    expect(replay.kind).toBe("EXISTING");
    expect(replay.artifact.runId).toBe(firstRun.id);
    expect(replay.artifact.byteLength).toBe(Buffer.byteLength(input.content, "utf8"));
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
      sensitivity: "INTERNAL",
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    });
    const metadata = await storage.contextArtifactsV2.getMetadata(artifact.artifactId);
    const safe = await storage.contextArtifactsV2.readSafeProjection(artifact.artifactId, 32);

    expect(metadata).toBeDefined();
    expect(metadata).not.toHaveProperty("content");
    expect(metadata?.sensitivity).toBe("INTERNAL");
    expect(Buffer.byteLength(safe ?? "", "utf8")).toBeLessThanOrEqual(32);
  });

  it("refuses sensitive generic projection while preserving controlled internal reads", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const artifact = await storage.contextArtifactsV2.createOrGet({
      runId: run.id,
      kind: "private",
      sourceRef: "fixture",
      content: "C3_PRIVATE_REASONING_SENTINEL",
      mimeType: "text/plain",
      sensitivity: "SENSITIVE",
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    });
    const newProjectionRejected = await storage.contextArtifactsV2
      .readSafeProjection(artifact.artifactId, 1024)
      .then(
        () => false,
        (error: unknown) =>
          error instanceof Error && error.message === "Sensitive artifact projection is forbidden.",
      );
    const legacyProjectionRejected = await storage.contextArtifacts
      .readSafeProjection(artifact.artifactId, 1024)
      .then(
        () => false,
        (error: unknown) =>
          error instanceof Error && error.message === "Sensitive artifact projection is forbidden.",
      );
    const controlledInternalReadSucceeded =
      (await storage.contextArtifactsV2.readInternal(artifact.artifactId))?.content ===
      "C3_PRIVATE_REASONING_SENTINEL";
    expect({
      newProjectionRejected,
      legacyProjectionRejected,
      controlledInternalReadSucceeded,
    }).toEqual({
      newProjectionRejected: true,
      legacyProjectionRejected: true,
      controlledInternalReadSucceeded: true,
    });
  });
});
