import {
  createRunId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";
import {
  computeVerificationCandidateTextHash,
  computeVerificationEvidenceDigest,
  createVerificationCompletionSeal,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

function plan(): VerificationPlan {
  const id = createVerificationPlanId();
  const checkId = createVerificationCheckId();
  return {
    id,
    runId: createRunId(),
    sourceStepId: createStepId(),
    plannerVersion: "phase-11d.v1",
    planHash: "a".repeat(64),
    candidateHash: "b".repeat(64),
    checks: [
      {
        id: checkId,
        planId: id,
        ordinal: 0,
        stage: "ACCEPTANCE",
        requirement: "REQUIRED",
        spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
        status: "PASSED",
        createdAt: createTimestampMs(1),
        startedAt: createTimestampMs(2),
        finishedAt: createTimestampMs(3),
      },
    ],
    createdAt: createTimestampMs(1),
  };
}

function evidence(inputPlan: VerificationPlan): VerificationEvidence {
  return {
    id: createVerificationEvidenceId(),
    planId: inputPlan.id,
    checkId: inputPlan.checks[0]!.id,
    kind: "TASK",
    summary: "accepted",
    details: { verdict: "PASS" },
    capturedAt: createTimestampMs(4),
  };
}

describe("Phase 11D completion integrity", () => {
  it("hashes final candidate text as UTF-8 SHA-256", () => {
    expect(computeVerificationCandidateTextHash("候选答案")).toBe(
      "85e83d6bde38aa24fd38abcb877941e2f411f6043554b50653346abcb00d56de",
    );
    expect(computeVerificationCandidateTextHash("候选答案")).not.toBe(
      computeVerificationCandidateTextHash("候选答案2"),
    );
  });

  it("computes an order-independent digest for the current plan evidence", () => {
    const currentPlan = plan();
    const item = evidence(currentPlan);
    const reversed = { ...currentPlan, checks: [...currentPlan.checks].reverse() };
    expect(computeVerificationEvidenceDigest(currentPlan, [item])).toBe(
      computeVerificationEvidenceDigest(reversed, [item]),
    );
    expect(() =>
      computeVerificationEvidenceDigest(currentPlan, [
        { ...item, planId: createVerificationPlanId() },
      ]),
    ).toThrow();
  });

  it("creates the same seal for the same completion subject and changes it when bound data changes", () => {
    const currentPlan = plan();
    const input = {
      runId: currentPlan.runId,
      planId: currentPlan.id,
      sourceStepId: currentPlan.sourceStepId,
      planHash: currentPlan.planHash,
      candidateHash: currentPlan.candidateHash!,
      evidenceDigest: "c".repeat(64),
      workspaceFreshnessHash: "d".repeat(64),
      gitFreshnessHash: "e".repeat(64),
    };
    const first = createVerificationCompletionSeal(input);
    expect(first).toEqual(createVerificationCompletionSeal(input));
    expect(first.sealHash).not.toBe(
      createVerificationCompletionSeal({ ...input, candidateHash: "f".repeat(64) }).sealHash,
    );
  });
});
