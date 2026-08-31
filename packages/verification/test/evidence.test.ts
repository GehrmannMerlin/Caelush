import {
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createCommandEvidence,
  createDiscoveryEvidence,
  type VerificationEvidenceSanitizer,
} from "../src/index.js";

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
});
