import {
  MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  VerificationEvidenceSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createCommandEvidence,
  createDiscoveryEvidence,
  type VerificationEvidenceSanitizer,
} from "../src/index.js";
import { serializedJsonBytes } from "../src/evidence.js";

const sanitizer: VerificationEvidenceSanitizer = {
  redactText(value) {
    return value.replaceAll("SECRET", "[REDACTED]");
  },
  boundText(value, maxBytes) {
    const text = value.slice(0, maxBytes);
    return {
      text,
      omittedBytes: Math.max(0, value.length - text.length),
      truncated: text.length < value.length,
    };
  },
};

describe("verification evidence normalization", () => {
  it("creates provenance-only discovery evidence", () => {
    const evidence = createDiscoveryEvidence({
      id: createVerificationEvidenceId(),
      planId: createVerificationPlanId(),
      checkId: createVerificationCheckId(),
      capturedAt: createTimestampMs(1_700_000_000_000),
      resolver: "NODE_PACKAGE_SCRIPT@phase-11b.v1",
      ecosystem: "NODE",
      packageScope: "packages/app",
      evidencePath: "package.json",
      packageManager: "pnpm",
      scriptName: "test",
      candidateHash: "a".repeat(64),
    });

    expect(evidence.kind).toBe("DISCOVERY");
    expect(evidence.details).not.toHaveProperty("body");
    expect(evidence.details).not.toHaveProperty("command");
  });

  it("redacts before bounding and never returns raw output", () => {
    const evidence = createCommandEvidence(
      {
        id: createVerificationEvidenceId(),
        planId: createVerificationPlanId(),
        checkId: createVerificationCheckId(),
        capturedAt: createTimestampMs(1_700_000_000_000),
        label: "project test",
        candidateHash: "b".repeat(64),
        exitCode: 1,
        stdout: "SAFE SECRET output",
        stderr: "SECRET failure",
        totalOutputBytes: 28,
        omittedBytes: 0,
        durationMs: 25,
      },
      sanitizer,
    );

    expect(evidence.details).toMatchObject({
      stdout: "SAFE [REDACTED] output",
      stderr: "[REDACTED] failure",
    });
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  });

  it("budgets command evidence after JSON escaping and keeps Unicode valid", () => {
    const source = '中文😀\u0000\n"'.repeat(2_000);
    const evidence = createCommandEvidence(
      {
        id: createVerificationEvidenceId(),
        planId: createVerificationPlanId(),
        checkId: createVerificationCheckId(),
        capturedAt: createTimestampMs(1_700_000_000_000),
        label: "project test",
        candidateHash: "b".repeat(64),
        exitCode: 0,
        stdout: source,
        stderr: source,
        totalOutputBytes: Buffer.byteLength(source, "utf8") * 2,
        omittedBytes: 0,
      },
      sanitizer,
    );
    const parsed = VerificationEvidenceSchema.parse(evidence);
    const details = parsed.details as {
      stdout: string;
      stderr: string;
      omittedBytes: number;
      truncated: boolean;
    };
    expect(details.truncated).toBe(true);
    expect(details.omittedBytes).toBeGreaterThan(0);
    expect(source.startsWith(details.stdout)).toBe(true);
    expect(source.startsWith(details.stderr)).toBe(true);
    expect(Array.from(details.stdout).join("")).toBe(details.stdout);
    expect(Array.from(details.stderr).join("")).toBe(details.stderr);
    expect(Buffer.byteLength(JSON.stringify(parsed.details), "utf8")).toBeLessThanOrEqual(
      MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
    );
  });

  it("classifies cyclic evidence serialization as a bounded infrastructure error", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    try {
      serializedJsonBytes(cyclic);
      throw new Error("expected cyclic serialization to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "VerificationEvidenceEncodingError",
        reasonCode: "VERIFICATION_EVIDENCE_ENCODING_ERROR",
      });
      expect((error as Error).message).not.toContain("circular");
    }
  });
});
