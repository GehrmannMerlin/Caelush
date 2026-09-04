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

describe("SqliteMemoryExtractionJobRepository", () => {
  it("is idempotent by source Run and survives reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-memory-job-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const first = await openCaelushStorage({ path: databasePath });
    const sessionId = createSessionId();
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: "extract memory",
      status: "COMPLETED",
      workspace: { id: createWorkspaceId(), path: "/repo" },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "fixture" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 1000 },
      createdAt: createTimestampMs(1),
      startedAt: createTimestampMs(2),
      finishedAt: createTimestampMs(3),
    });
    await first.sessions.insert({
      id: sessionId,
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    });
    await first.runs.insert(run);
    const job = await first.memoryExtractionJobs.createOrGet({
      id: "memory-job:1",
      sourceRunId: run.id,
      projectId: "project-1",
      createdAt: createTimestampMs(10),
    });
    const duplicate = await first.memoryExtractionJobs.createOrGet({
      id: "memory-job:2",
      sourceRunId: run.id,
      projectId: "project-1",
      createdAt: createTimestampMs(11),
    });
    expect(duplicate.id).toBe(job.id);
    await first.close();
    const second = await openCaelushStorage({ path: databasePath });
    await expect(second.memoryExtractionJobs.get(job.id)).resolves.toMatchObject({
      status: "PENDING",
      sourceRunId: run.id,
    });
    await second.close();
  });
});
