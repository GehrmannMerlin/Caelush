import { describe, expect, it } from "vitest";
import { createDeterministicMinimalCheckpoint } from "../src/checkpoint.js";
import { ContextRehydrator } from "../src/context-rehydrator.js";

describe("ContextRehydrator", () => {
  it("lets authoritative workspace and approval state override stale checkpoint facts", async () => {
    const checkpoint = createDeterministicMinimalCheckpoint({
      goal: "inspect",
      changedFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      sourceRange: { from: 1, to: 2 },
    });
    const result = await new ContextRehydrator().rehydrate({
      checkpoint,
      authorities: {
        goal: "inspect",
        changedFiles: ["src/changed.ts"],
        pendingApprovals: [],
        activeProcesses: ["session-1"],
        verificationState: "PASSED_BUT_NOT_COMPLETION_AUTHORITY",
        resourceGovernance: "ACTIVE",
        projectFacts: ["package manager: pnpm"],
      },
    });

    expect(result.changedFiles).toEqual(["src/changed.ts"]);
    expect(result.activeProcesses).toEqual(["session-1"]);
    expect(result.pendingApprovals).toEqual([]);
    expect(result.verificationState).toBe("PASSED_BUT_NOT_COMPLETION_AUTHORITY");
  });
});
