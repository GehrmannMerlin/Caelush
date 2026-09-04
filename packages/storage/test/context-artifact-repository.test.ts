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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteContextArtifactRepository", () => {
  it("keeps large raw output durable while exposing bounded safe projections", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-artifact-"));
    directories.push(directory);
    const storage = await openCaelushStorage({ path: path.join(directory, "caelush.db") });
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "persist artifact",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: "/repo" },
      model: { provider: "fixture", model: "fixture-model" },
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
    const content = `${"stdout line\n".repeat(20_000)}tail sentinel`;
    const artifact = await storage.contextArtifacts.createOrGet({
      runId: run.id,
      kind: "exec.stdout",
      sourceRef: "tool:call-1",
      content,
      mimeType: "text/plain",
      sensitivity: "INTERNAL",
      createdSequence: 1,
      createdAt: createTimestampMs(3),
    });
    expect(artifact.content).toBe(content);
    expect(
      await storage.contextArtifacts.createOrGet({
        runId: run.id,
        kind: "exec.stdout",
        sourceRef: "tool:call-1",
        content,
        mimeType: "text/plain",
        sensitivity: "INTERNAL",
        createdSequence: 1,
        createdAt: createTimestampMs(3),
      }),
    ).toMatchObject({ artifactId: artifact.artifactId });
    const metadata = await storage.contextArtifacts.getMetadata(artifact.artifactId);
    expect(metadata).toBeDefined();
    expect(metadata).not.toHaveProperty("content");
    const safe = await storage.contextArtifacts.readSafeProjection(artifact.artifactId, 512);
    expect(safe).toContain("artifact projection truncated");
    expect(Buffer.byteLength(safe ?? "", "utf8")).toBeLessThanOrEqual(512);
    await storage.close();
  });
});
