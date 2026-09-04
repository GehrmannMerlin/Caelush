export type MemoryExtractionJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface MemoryExtractionJob {
  readonly id: string;
  readonly sourceRunId: string;
  readonly projectId: string;
  readonly status: MemoryExtractionJobStatus;
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}

export interface MemoryExtractionJobCreateInput {
  readonly id: string;
  readonly sourceRunId: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly status?: MemoryExtractionJobStatus;
}

export interface MemoryExtractionJobStore {
  createOrGet(input: MemoryExtractionJobCreateInput): Promise<MemoryExtractionJob>;
  get(id: string): Promise<MemoryExtractionJob | undefined>;
  listPending(): Promise<readonly MemoryExtractionJob[]>;
  claim(id: string, now: number): Promise<MemoryExtractionJob | undefined>;
  complete(id: string, now: number): Promise<MemoryExtractionJob | undefined>;
  fail(id: string, now: number, message: string): Promise<MemoryExtractionJob | undefined>;
}

export function createMemoryExtractionJob(
  input: MemoryExtractionJobCreateInput,
): MemoryExtractionJob {
  if (input.id.trim() === "" || input.sourceRunId.trim() === "" || input.projectId.trim() === "") {
    throw new RangeError("memory extraction job identity must not be empty");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new RangeError("memory extraction job timestamp is invalid");
  }
  if (input.status !== undefined && input.status !== "PENDING") {
    throw new RangeError("new memory extraction jobs must start PENDING");
  }
  return Object.freeze({
    id: input.id,
    sourceRunId: input.sourceRunId,
    projectId: input.projectId,
    status: "PENDING" as const,
    attempt: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}
