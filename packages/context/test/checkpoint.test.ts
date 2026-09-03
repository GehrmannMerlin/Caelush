import { describe, expect, it } from "vitest";
import {
  createDeterministicMinimalCheckpoint,
  createStructuredCheckpoint,
} from "../src/checkpoint.js";

describe("StructuredCheckpoint", () => {
  it("retains the goal and bounded recovery facts with a schema version", () => {
    const checkpoint = createStructuredCheckpoint({
      goal: "do not modify database/",
      constraints: ["database/ is immutable"],
      completedWork: ["inspected source"],
      inProgress: ["running tests"],
      blocked: [],
      importantDiscoveries: ["the workspace uses pnpm"],
      keyDecisions: ["preserve the existing API"],
      changedFiles: ["src/index.ts"],
      readFiles: ["src/index.ts"],
      recentErrors: [],
      verificationState: "PENDING",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "within limits",
      criticalReferences: ["tool-1"],
      nextIntent: "continue tests",
      sourceRange: { from: 1, to: 20 },
    });

    expect(checkpoint.version).toBe(1);
    expect(checkpoint.goal).toBe("do not modify database/");
    expect(checkpoint.changedFiles).toEqual(["src/index.ts"]);
  });

  it("rejects unbounded checkpoint fields", () => {
    expect(() =>
      createStructuredCheckpoint({
        goal: "x".repeat(100_001),
        constraints: [],
        completedWork: [],
        inProgress: [],
        blocked: [],
        importantDiscoveries: [],
        keyDecisions: [],
        changedFiles: [],
        readFiles: [],
        recentErrors: [],
        verificationState: "PENDING",
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "",
        criticalReferences: [],
        nextIntent: "",
        sourceRange: { from: 0, to: 0 },
      }),
    ).toThrow(/goal/);
  });

  it("builds a minimal fallback without fabricated completion", () => {
    const checkpoint = createDeterministicMinimalCheckpoint({
      goal: "inspect",
      changedFiles: ["src/a.ts"],
      recentErrors: ["test failed"],
      verificationState: "PENDING",
      sourceRange: { from: 2, to: 4 },
    });
    expect(checkpoint.completedWork).toEqual([]);
    expect(checkpoint.verificationState).toBe("PENDING");
    expect(checkpoint.version).toBe(1);
  });
});
