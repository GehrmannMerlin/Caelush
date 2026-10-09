import {
  MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  VerificationEvidenceSchema,
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
    expect(VerificationEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("summarizes oversized JSON-escaped Git evidence and fails the check closed", () => {
    const paths = Array.from({ length: 33 }, (_, index) => ({
      path: "src/" + "nested/".repeat(12) + "file-" + String(index).padStart(2, "0") + ".ts",
      changeType: "MODIFIED" as const,
    }));
    const input: GitReviewInput = {
      changedFiles: paths,
      status: {
        available: true,
        clean: false,
        entries: paths.map(({ path }) => ({
          path,
          kind: "TRACKED" as const,
          indexStatus: " ",
          worktreeStatus: "M",
        })),
      },
      diffs: paths.map(({ path }) => ({
        path,
        diff: '\u0000\n"😀'.repeat(600),
        truncated: false,
      })),
    };
    const result = reviewGitChangeset(input);
    const evidence = createGitEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    const parsed = VerificationEvidenceSchema.parse(evidence);

    expect(result.status).toBe("ERROR");
    expect(result.reviewComplete).toBe(false);
    expect(parsed.details).toMatchObject({
      evidenceTruncated: true,
      reviewComplete: false,
      gitFreshnessHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      attributedPathCount: 33,
    });
    expect(Buffer.byteLength(JSON.stringify(parsed.details), "utf8")).toBeLessThanOrEqual(
      MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
    );
  });
});
