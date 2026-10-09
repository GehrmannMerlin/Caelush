import {
  MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  VerificationEvidenceSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceEvidence,
  computeWorkspaceFreshnessHash,
  verifyWorkspaceInspection,
  type WorkspaceInspectionResult,
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

function oversizedT013EquivalentResult(): {
  readonly result: WorkspaceInspectionResult;
  readonly legacyDetails: Record<string, unknown>;
} {
  const changed = Array.from({ length: 33 }, (_, index) => ({
    path: `src/catalog/module-${String(index).padStart(2, "0")}.tsx`,
    changeType: "MODIFIED" as const,
  }));
  const contentFingerprints = Object.fromEntries(
    changed.map(({ path }, index) => [
      path,
      { kind: "FILE" as const, sizeBytes: 2_048, sha256: index.toString(16).padStart(64, "0") },
    ]),
  );
  const fingerprintEntries = changed.map(({ path }) => ({
    path,
    fingerprint: contentFingerprints[path]!,
  }));
  const result: WorkspaceInspectionResult = {
    status: "PASSED",
    checkedFileCount: 33,
    createdCount: 0,
    modifiedCount: 33,
    movedCount: 0,
    deletedCount: 0,
    missingPaths: [],
    unexpectedKinds: [],
    symlinkPaths: [],
    inspectionComplete: true,
    inspectionHash: "a".repeat(64),
    contentFingerprints,
    workspaceFreshnessHash: computeWorkspaceFreshnessHash(fingerprintEntries),
    artifactEvidence: changed.map(({ path }, index) => ({
      path,
      kind: "TEXT" as const,
      sha256: contentFingerprints[path]!.sha256,
      sizeBytes: 2_048,
      content: "",
      truncated: false,
    })),
  };
  const makeLegacyDetails = (candidate: WorkspaceInspectionResult): Record<string, unknown> => ({
    checkedFileCount: candidate.checkedFileCount,
    createdCount: candidate.createdCount,
    modifiedCount: candidate.modifiedCount,
    movedCount: candidate.movedCount,
    deletedCount: candidate.deletedCount,
    missingPaths: [...candidate.missingPaths],
    unexpectedKinds: [...candidate.unexpectedKinds],
    symlinkPaths: [...candidate.symlinkPaths],
    inspectionComplete: candidate.inspectionComplete,
    inspectionHash: candidate.inspectionHash,
    artifactEvidence: candidate.artifactEvidence.map((artifact) => ({ ...artifact })),
    ...(candidate.workspaceFreshnessHash === undefined
      ? {}
      : {
          workspaceFreshnessHash: candidate.workspaceFreshnessHash,
          contentFingerprints: Object.fromEntries(
            Object.entries(candidate.contentFingerprints).map(([path, fingerprint]) => [
              path,
              { ...fingerprint },
            ]),
          ),
        }),
    status: candidate.status,
  });

  const emptyBytes = Buffer.byteLength(JSON.stringify(makeLegacyDetails(result)), "utf8");
  const targetBytes = 46_379;
  const additionalBytes = targetBytes - emptyBytes;
  if (additionalBytes <= 0) throw new Error("T013 fixture base unexpectedly exceeds target size");
  const baseContentBytes = Math.floor(additionalBytes / result.artifactEvidence.length);
  const extraContentBytes = additionalBytes % result.artifactEvidence.length;
  const sizedResult: WorkspaceInspectionResult = {
    ...result,
    artifactEvidence: result.artifactEvidence.map((artifact, index) => ({
      ...artifact,
      content: "x".repeat(baseContentBytes + (index < extraContentBytes ? 1 : 0)),
    })),
  };
  const legacyDetails = makeLegacyDetails(sizedResult);
  if (Buffer.byteLength(JSON.stringify(legacyDetails), "utf8") !== targetBytes) {
    throw new Error("T013 fixture did not reach its deterministic byte target");
  }
  return { result: sizedResult, legacyDetails };
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
    expect(VerificationEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("refuses to encode an incomplete inspection as a successful result", () => {
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path: "src/catalog.ts", changeType: "MODIFIED" }],
      facts: { inspectionComplete: false, paths: [] },
    });
    expect(result.status).toBe("ERROR");
    expect(() =>
      createWorkspaceEvidence({
        id: createVerificationEvidenceId(),
        planId: createVerificationPlanId(),
        checkId: createVerificationCheckId(),
        capturedAt: 1_700_000_000_000 as never,
        result: { ...result, status: "PASSED" },
      }),
    ).toThrow("Verification evidence could not be encoded");
  });

  it("bounds the 33-file T013 evidence candidate by its final serialized UTF-8 size", () => {
    const { result, legacyDetails } = oversizedT013EquivalentResult();
    expect(Buffer.byteLength(JSON.stringify(legacyDetails), "utf8")).toBe(46_379);
    expect(
      VerificationEvidenceSchema.safeParse({
        id: createVerificationEvidenceId(),
        planId: createVerificationPlanId(),
        checkId: createVerificationCheckId(),
        kind: "WORKSPACE",
        summary: "Workspace change sanity passed",
        details: legacyDetails,
        capturedAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);

    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    const parsed = VerificationEvidenceSchema.parse(evidence);
    expect(Buffer.byteLength(JSON.stringify(parsed.details), "utf8")).toBe(
      MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
    );
    expect(parsed.details).toMatchObject({
      checkedFileCount: 33,
      inspectionComplete: true,
      inspectionHash: result.inspectionHash,
      workspaceFreshnessHash: result.workspaceFreshnessHash,
      status: "PASSED",
    });
  });

  it("keeps a real missing-path failure when large path facts must be summarized", () => {
    const files = Array.from({ length: 33 }, (_, index) => ({
      path: `src/${"nested/".repeat(30)}missing-${String(index).padStart(2, "0")}.tsx`,
      changeType: "CREATED" as const,
    }));
    const result = verifyWorkspaceInspection({
      changedFiles: files,
      facts: {
        inspectionComplete: true,
        paths: files.map(({ path }) => ({ path, kind: "MISSING" })),
      },
    });
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    const parsed = VerificationEvidenceSchema.parse(evidence);
    expect(result.status).toBe("FAILED");
    expect(parsed.details).toMatchObject({
      status: "FAILED",
      missingPathCount: 33,
      inspectionComplete: true,
    });
    expect(parsed.details).toMatchObject({
      evidenceTruncated: true,
      evidenceTruncation: { pathsTruncated: true },
      missingPathsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("marks a small path list truncated when an individual path is abbreviated", () => {
    const path = `src/${"nested/".repeat(30)}missing-file.ts`;
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path, changeType: "CREATED" }],
      facts: { inspectionComplete: true, paths: [{ path, kind: "MISSING" }] },
    });
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    expect(evidence.details).toMatchObject({
      status: "FAILED",
      missingPathCount: 1,
      evidenceTruncated: true,
      evidenceTruncation: { pathsTruncated: true },
      missingPathsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("budgets JSON-escaped Unicode content without splitting a code point", () => {
    const path = "src/中文-evidence.ts";
    const content = '中文😀\u0000\n"'.repeat(1_000);
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path, changeType: "MODIFIED" }],
      facts: {
        inspectionComplete: true,
        paths: [
          {
            path,
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 12_000, sha256: "c".repeat(64) },
          },
        ],
        artifactEvidence: [
          {
            path,
            kind: "TEXT",
            sha256: "c".repeat(64),
            sizeBytes: 12_000,
            content,
            truncated: false,
          },
        ],
      },
    });
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    const parsed = VerificationEvidenceSchema.parse(evidence);
    const details = parsed.details as {
      artifactEvidence: readonly { content?: string; truncated: boolean }[];
    };
    const boundedContent = details.artifactEvidence[0]?.content;
    expect(boundedContent).toBeDefined();
    expect(content.startsWith(boundedContent!)).toBe(true);
    expect(Array.from(boundedContent!).join("")).toBe(boundedContent);
    expect(details.artifactEvidence[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(parsed.details), "utf8")).toBeLessThanOrEqual(
      MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
    );
  });

  it("never includes a sensitive artifact body in durable evidence", () => {
    const path = "src/credentials.json";
    const result = verifyWorkspaceInspection({
      changedFiles: [{ path, changeType: "MODIFIED" }],
      facts: {
        inspectionComplete: true,
        paths: [
          {
            path,
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 6, sha256: "d".repeat(64) },
          },
        ],
        artifactEvidence: [
          {
            path,
            kind: "SENSITIVE",
            sha256: "d".repeat(64),
            sizeBytes: 6,
            content: "api-key",
            truncated: false,
          },
        ],
      },
    });
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    expect(JSON.stringify(evidence)).not.toContain("api-key");
  });

  it("records when a large fingerprint set cannot support a freshness seal", () => {
    const files = Array.from({ length: 1_000 }, (_, index) => ({
      path: "src/generated/module-" + String(index).padStart(4, "0") + ".ts",
      changeType: "MODIFIED" as const,
    }));
    const result = verifyWorkspaceInspection({
      changedFiles: files,
      facts: {
        inspectionComplete: true,
        paths: files.map(({ path }, index) => ({
          path,
          kind: "FILE" as const,
          fingerprint: {
            kind: "FILE" as const,
            sizeBytes: 100,
            sha256: index.toString(16).padStart(64, "0"),
          },
        })),
      },
    });
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    const parsed = VerificationEvidenceSchema.parse(evidence);
    expect(result.status).toBe("PASSED");
    expect(result.workspaceFreshnessHash).toBeUndefined();
    expect(parsed.details).toMatchObject({
      status: "PASSED",
      inspectionComplete: true,
      evidenceTruncated: true,
      evidenceTruncation: {
        fingerprintsOmittedCount: 1_000,
        fingerprintsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(parsed.details).not.toHaveProperty("workspaceFreshnessHash");
  });

  it("projects bounded changed-file content only when it matches the authoritative fingerprint", () => {
    const result = verifyWorkspaceInspection({
      changedFiles: [
        { path: "src/z.ts", changeType: "CREATED" },
        { path: "src/a.ts", changeType: "MODIFIED" },
      ],
      facts: {
        inspectionComplete: true,
        paths: [
          {
            path: "src/z.ts",
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 5, sha256: "z".repeat(64) },
          },
          {
            path: "src/a.ts",
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 5, sha256: "a".repeat(64) },
          },
        ],
        artifactEvidence: [
          {
            path: "unattributed.txt",
            kind: "TEXT",
            sha256: "u".repeat(64),
            sizeBytes: 1,
            content: "must not be projected",
            truncated: false,
          },
          {
            path: "src/z.ts",
            kind: "TEXT",
            sha256: "z".repeat(64),
            sizeBytes: 5,
            content: "z-content",
            truncated: false,
          },
          {
            path: "src/a.ts",
            kind: "TEXT",
            sha256: "wrong".padEnd(64, "x"),
            sizeBytes: 5,
            content: "unbound-content",
            truncated: false,
          },
        ],
      },
    });
    expect(result.artifactEvidence).toEqual([
      {
        path: "src/a.ts",
        kind: "UNAVAILABLE",
        sha256: "a".repeat(64),
        sizeBytes: 5,
        truncated: false,
      },
      {
        path: "src/z.ts",
        kind: "TEXT",
        sha256: "z".repeat(64),
        sizeBytes: 5,
        content: "z-content",
        truncated: false,
      },
    ]);
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result,
    });
    expect(evidence.details).toMatchObject({
      artifactEvidence: result.artifactEvidence,
      workspaceFreshnessHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(evidence)).not.toContain("must not be projected");
    expect(JSON.stringify(evidence)).not.toContain("unbound-content");
  });

  it("records a freshness hash over raw-byte fingerprints and detects newline changes", () => {
    const first = verifyWorkspaceInspection({
      changedFiles: [{ path: "src/a.ts", changeType: "MODIFIED" }],
      facts: {
        inspectionComplete: true,
        paths: [
          {
            path: "src/a.ts",
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 4, sha256: "a".repeat(64) },
          },
        ],
      },
    });
    const second = verifyWorkspaceInspection({
      changedFiles: [{ path: "src/a.ts", changeType: "MODIFIED" }],
      facts: {
        inspectionComplete: true,
        paths: [
          {
            path: "src/a.ts",
            kind: "FILE",
            fingerprint: { kind: "FILE", sizeBytes: 5, sha256: "b".repeat(64) },
          },
        ],
      },
    });
    expect(first.workspaceFreshnessHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.workspaceFreshnessHash).not.toBe(first.workspaceFreshnessHash);
    const evidence = createWorkspaceEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: 1_700_000_000_000 as never,
      result: first,
    });
    expect(evidence.details).toMatchObject({
      workspaceFreshnessHash: first.workspaceFreshnessHash,
    });
  });
});
