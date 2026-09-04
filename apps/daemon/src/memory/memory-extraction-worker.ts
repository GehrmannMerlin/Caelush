import {
  type MemoryCandidate,
  type MemoryExtractionJob,
  type MemoryExtractionJobStore,
  type MemoryStore,
} from "@caelush/memory";

export interface MemoryExtractionWorkerOptions {
  readonly jobs: MemoryExtractionJobStore;
  readonly memory: MemoryStore;
  extract(input: { readonly job: MemoryExtractionJob }): Promise<readonly MemoryCandidate[]>;
  readonly now?: () => number;
}

export class MemoryExtractionWorker {
  private running = false;
  private readonly now: () => number;

  constructor(private readonly options: MemoryExtractionWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const pending = await this.options.jobs.listPending();
      const candidate = pending[0];
      if (candidate === undefined) return false;
      const job = await this.options.jobs.claim(candidate.id, this.now());
      if (job === undefined) return false;
      try {
        for (const memoryCandidate of await this.options.extract({ job })) {
          await this.options.memory.save({
            ...memoryCandidate,
            scope: "PROJECT",
            projectId: job.projectId,
            sourceRunIds: [job.sourceRunId],
            evidenceRefs: memoryCandidate.evidenceRefs,
          });
        }
        await this.options.jobs.complete(job.id, this.now());
      } catch (error) {
        await this.options.jobs.fail(
          job.id,
          this.now(),
          error instanceof Error ? error.message : "memory extraction failed",
        );
      }
      return true;
    } finally {
      this.running = false;
    }
  }
}
