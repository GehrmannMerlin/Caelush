import {
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createGitEvidence, reviewGitChangeset, type GitReviewInput } from "../src/index.js";

function base(): GitReviewInput {
  return {
    changedFiles: [
      { path: "src/a.ts", changeType: "MODIFIED" },
      { path: "src/new.ts", changeType: "CREATED" },
    ],
    status: {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      clean: false,
      entries: [
        { path: "src/a.ts", kind: "TRACKED", indexStatus: " ", worktreeStatus: "M" },
        { path: "src/new.ts", kind: "UNTRACKED", indexStatus: "?", worktreeStatus: "?" },
        { path: "notes.txt", kind: "TRACKED", indexStatus: " ", worktreeStatus: "M" },
      ],
      truncated: false,
    },
    diffs: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n", truncated: false }],
  };
}

describe("Git changeset verification", () => {
  it("passes with bounded per-path status and diff evidence", () => {
    const result = reviewGitChangeset(base());
    expect(result.status).toBe("PASSED");
    expect(result.attributedPaths).toEqual(["src/a.ts", "src/new.ts"]);
    expect(result.unattributedDirtyPaths).toEqual(["notes.txt"]);
    expect(result.diffHashes["src/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.reviewComplete).toBe(true);
  });

  it("fails on unmerged status and errors on incomplete bounded data", () => {
    expect(
      reviewGitChangeset({
        ...base(),
        status: {
          ...base().status,
          entries: [{ ...base().status.entries![0]!, kind: "UNMERGED" }],
        },
      }).status,
    ).toBe("FAILED");
    expect(
      reviewGitChangeset({ ...base(), status: { ...base().status, truncated: true } }).status,
    ).toBe("ERROR");
    expect(
      reviewGitChangeset({
        ...base(),
        diffs: [{ path: "src/a.ts", diff: "too large", truncated: true }],
      }).status,
    ).toBe("ERROR");
  });

  it("represents unavailable repositories according to the check requirement", () => {
    expect(
      reviewGitChangeset({ changedFiles: [], status: { available: false }, diffs: [] }).status,
    ).toBe("SKIPPED");
    expect(
      reviewGitChangeset({
        changedFiles: [],
        requirement: "REQUIRED",
        status: { available: false },
        diffs: [],
      }).status,
    ).toBe("ERROR");
  });

  it("creates bounded evidence and marks a declared tracked path with no net diff", () => {
    const result = reviewGitChangeset({
      ...base(),
      diffs: [{ path: "src/a.ts", diff: "", truncated: false }],
    });
    expect(result.noNetDiffPaths).toEqual(["src/a.ts"]);
    const evidence = createGitEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    expect(evidence.kind).toBe("GIT");
    expect(JSON.stringify(evidence.details)).not.toContain("git add");
  });
});
