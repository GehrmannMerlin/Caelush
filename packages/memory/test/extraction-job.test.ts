import { describe, expect, it } from "vitest";
import { createMemoryExtractionJob, type MemoryExtractionJob } from "../src/index.js";

describe("memory extraction jobs", () => {
  it("creates a bounded project-scoped pending job and rejects terminal failures", () => {
    const job = createMemoryExtractionJob({
      id: "memory-job:1",
      sourceRunId: "run-1",
      projectId: "project-1",
      createdAt: 10,
    });
    expect(job).toMatchObject({
      status: "PENDING",
      sourceRunId: "run-1",
      projectId: "project-1",
      attempt: 0,
    });
    expect(() =>
      createMemoryExtractionJob({
        id: "memory-job:2",
        sourceRunId: "run-2",
        projectId: "project-1",
        createdAt: 10,
        status: "COMPLETED" as MemoryExtractionJob["status"],
      }),
    ).toThrow();
  });
});
