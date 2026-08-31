import {
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceEvidence,
  verifyWorkspaceInspection,
  type WorkspaceInspectionFacts,
} from "../src/index.js";

const changedFiles = [
  { path: "src/new.ts", changeType: "CREATED" as const },
  { path: "src/old.ts", changeType: "MODIFIED" as const },
  { path: "src/moved.ts", changeType: "MOVED" as const },
  { path: "src/removed.ts", changeType: "DELETED" as const },
];

function facts(overrides: Partial<WorkspaceInspectionFacts> = {}): WorkspaceInspectionFacts {
  return {
    inspectionComplete: true,
    paths: [
      { path: "src/moved.ts", kind: "FILE" },
      { path: "src/new.ts", kind: "FILE" },
      { path: "src/old.ts", kind: "FILE" },
      { path: "src/removed.ts", kind: "MISSING" },
    ],
    ...overrides,
  };
}

describe("workspace verification", () => {
  it("passes when declared changes match bounded workspace metadata", () => {
    const result = verifyWorkspaceInspection({ changedFiles, facts: facts() });
    expect(result.status).toBe("PASSED");
    expect(result.checkedFileCount).toBe(4);
    expect(result.missingPaths).toEqual([]);
    expect(result.inspectionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails for missing, existing deleted, or symlinked declared paths", () => {
    const result = verifyWorkspaceInspection({
      changedFiles,
      facts: facts({
        paths: [
          { path: "src/moved.ts", kind: "SYMLINK" },
          { path: "src/new.ts", kind: "MISSING" },
          { path: "src/old.ts", kind: "SYMLINK" },
          { path: "src/removed.ts", kind: "FILE" },
        ],
      }),
    });
    expect(result.status).toBe("FAILED");
    expect(result.missingPaths).toEqual(["src/new.ts"]);
    expect(result.symlinkPaths).toEqual(["src/moved.ts", "src/old.ts"]);
    expect(result.unexpectedKinds).toEqual(["src/removed.ts:FILE"]);
  });

  it("returns ERROR when inspection is incomplete or a path escaped the workspace", () => {
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path: "../outside.ts", changeType: "CREATED" }],
      facts: facts({
        inspectionComplete: false,
        paths: [{ path: "../outside.ts", kind: "OUTSIDE" }],
      }),
    });
    expect(result.status).toBe("ERROR");
  });

  it("fails closed when the Runtime returns duplicate path observations", () => {
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path: "src/a.ts", changeType: "MODIFIED" }],
      facts: {
        inspectionComplete: true,
        paths: [
          { path: "src/a.ts", kind: "FILE" },
          { path: "src/a.ts", kind: "FILE" },
        ],
      },
    });
    expect(result.status).toBe("ERROR");
    expect(result.inspectionComplete).toBe(false);
  });

  it("creates bounded metadata-only evidence with a deterministic hash", () => {
    const first = verifyWorkspaceInspection({
      changedFiles: [...changedFiles].reverse(),
      facts: facts(),
    });
    const second = verifyWorkspaceInspection({ changedFiles, facts: facts() });
    expect(first.inspectionHash).toBe(second.inspectionHash);
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result: first,
    });
    expect(JSON.stringify(evidence)).not.toContain("contents");
    expect(evidence.details).toMatchObject({ checkedFileCount: 4, inspectionComplete: true });
  });
});
