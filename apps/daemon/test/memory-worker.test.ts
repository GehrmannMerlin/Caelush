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
      commit: {
        commit: async ({ candidates }) => {
          for (const candidate of candidates) await memory.save(candidate);
          return "COMMITTED";
        },
      },
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

  it("sends late extraction to the fenced commit port without completing a deleted job", async () => {
    const jobs = new TestJobs();
    let release!: (value: readonly never[]) => void;
    let entered!: () => void;
    const extracted = new Promise<readonly never[]>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const received: unknown[] = [];
    const worker = new MemoryExtractionWorker({
      jobs,
      now: () => 2,
      extract: async () => {
        entered();
        return extracted;
      },
      commit: {
        commit: async (input) => {
          received.push(input);
          return "STALE";
        },
      },
    });
    const running = worker.runOnce();
    await started;
    jobs.deleted = true;
    release([]);
    await expect(running).resolves.toBe(true);
    expect(received).toEqual([{ jobId: "memory-job:1", attempt: 1, candidates: [], now: 2 }]);
    expect(await jobs.get()).toBeUndefined();
    expect(jobs.job.status).toBe("RUNNING");
  });
});

class TestJobs implements MemoryExtractionJobStore {
  deleted = false;
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
    return this.deleted ? undefined : this.job;
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
