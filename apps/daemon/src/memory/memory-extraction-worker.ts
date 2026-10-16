import {
  type MemoryCandidate,
  type MemoryExtractionJob,
  type MemoryExtractionJobStore,
  type MemoryExtractionCommitPort,
} from "@caelush/memory";

export interface MemoryExtractionWorkerOptions {
  readonly jobs: MemoryExtractionJobStore;
  readonly commit: MemoryExtractionCommitPort;
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
        const candidates = await this.options.extract({ job });
        await this.options.commit.commit({
          jobId: job.id,
          attempt: job.attempt,
          candidates,
          now: this.now(),
        });
      } catch {
        await this.options.jobs.fail(job.id, this.now(), "Memory extraction failed.", job.attempt);
      }
      return true;
    } finally {
      this.running = false;
    }
  }
}
