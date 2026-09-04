import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  createMemoryExtractionJob,
  type MemoryExtractionJobStore,
} from "@caelush/memory";
import { MemoryExtractionWorker } from "../src/memory/memory-extraction-worker.js";

describe("MemoryExtractionWorker", () => {
  it("does not persist candidates without evidence or secret-bearing facts", async () => {
    const jobs = new TestJobs();
    const memory = new InMemoryMemoryStore({ now: () => 2 });
    const worker = new MemoryExtractionWorker({
      jobs,
      memory,
      now: () => 2,
      extract: async () => [
        {
          scope: "PROJECT",
          projectId: "project-1",
          topic: "credentials",
          fact: "api_key: do-not-store",
          confidence: 1,
          evidenceRefs: ["run:1"],
          sensitivity: "SENSITIVE",
        },
      ],
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(memory.list()).resolves.toHaveLength(0);
    expect(jobs.job.status).toBe("FAILED");
  });
});

class TestJobs implements MemoryExtractionJobStore {
  job = createMemoryExtractionJob({
    id: "memory-job:1",
    sourceRunId: "run-1",
    projectId: "project-1",
    createdAt: 1,
  });

  async createOrGet() {
    return this.job;
  }
  async get() {
    return this.job;
  }
  async listPending() {
    return this.job.status === "PENDING" ? [this.job] : [];
  }
  async claim(_id: string, now: number) {
    this.job = { ...this.job, status: "RUNNING", attempt: this.job.attempt + 1, updatedAt: now };
    return this.job;
  }
  async complete(_id: string, now: number) {
    this.job = { ...this.job, status: "COMPLETED", updatedAt: now };
    return this.job;
  }
  async fail(_id: string, now: number, message: string) {
    this.job = { ...this.job, status: "FAILED", updatedAt: now, lastError: message };
    return this.job;
  }
}
