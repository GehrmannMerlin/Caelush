import { describe, expect, it } from "vitest";

import {
  acceptCompactionCandidate,
  evaluateCompactionCandidate,
  maxNewTokensForTarget,
  resolveCompactionRetentionBudget,
} from "@caelush/agent";

describe("deep compaction retention budget", () => {
  it("calculates a cache-hit advisory without making it an execution ceiling", () => {
    expect(maxNewTokensForTarget({ reusableTokens: 40_000, target: 0.95 })).toBe(2_105);
    expect(maxNewTokensForTarget({ reusableTokens: 40_000, target: 1 })).toBe(0);
    expect(() => maxNewTokensForTarget({ reusableTokens: 40_000, target: 0 })).toThrow();
  });

  it("retains only the explicit fixed, recent, checkpoint, and boundary allowance", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 12_000,
      recentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 1_000_000,
    });

    expect(budget).toMatchObject({
      fixedTokens: 12_000,
      recentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      targetInputTokens: 44_192,
    });
    expect(acceptCompactionCandidate({ inputTokens: 44_192, budget })).toBe(true);
    expect(acceptCompactionCandidate({ inputTokens: 800_000, budget })).toBe(false);
    expect(acceptCompactionCandidate({ inputTokens: 880_000, budget })).toBe(false);
  });

  it("reports floor-limited when mandatory input consumes the available window", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 48_000,
      recentTokens: 20_000,
      protectedRecentTokens: 2_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 50_000,
    });

    expect(budget.targetInputTokens).toBe(80_192);
    expect(budget.availableInputTokens).toBe(50_000);
    expect(budget.protectedFloorInputTokens).toBe(50_000);
    expect(acceptCompactionCandidate({ inputTokens: 50_001, budget })).toBe(false);
  });

  it("accepts a substantial safe reduction above the preferred target", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 12_000,
      recentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 1_000_000,
    });

    expect(
      evaluateCompactionCandidate({
        inputTokens: 220_000,
        inputTokensBefore: 1_000_000,
        compressibleTokens: 800_000,
        minimumReleaseRatio: 0.7,
        minimumLegalCut: false,
        budget,
      }),
    ).toMatchObject({ accepted: true, status: "ELASTIC" });
  });

  it("permits a below-threshold release only at the proven minimum legal cut", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 10_000,
      recentTokens: 20_000,
      protectedRecentTokens: 40_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 80_000,
    });

    expect(
      evaluateCompactionCandidate({
        inputTokens: 50_000,
        inputTokensBefore: 80_000,
        compressibleTokens: 100_000,
        minimumReleaseRatio: 0.7,
        minimumLegalCut: true,
        budget,
      }),
    ).toMatchObject({ accepted: true, status: "FLOOR_LIMITED" });
    expect(
      evaluateCompactionCandidate({
        inputTokens: 50_000,
        inputTokensBefore: 80_000,
        compressibleTokens: 100_000,
        minimumReleaseRatio: 0.7,
        minimumLegalCut: false,
        budget,
      }),
    ).toMatchObject({ accepted: false, reason: "INSUFFICIENT_REDUCTION" });
    expect(
      evaluateCompactionCandidate({
        inputTokens: 65_000,
        inputTokensBefore: 80_000,
        compressibleTokens: 100_000,
        minimumReleaseRatio: 0.7,
        minimumLegalCut: true,
        budget,
      }),
    ).toMatchObject({ accepted: false, reason: "INSUFFICIENT_REDUCTION" });
  });

  it("does not waive a hard overflow or accept a low-release candidate", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 12_000,
      recentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 1_000_000,
    });
    const candidate = {
      inputTokensBefore: 1_000_000,
      compressibleTokens: 800_000,
      minimumReleaseRatio: 0.7,
      minimumLegalCut: false,
      budget,
    };

    expect(evaluateCompactionCandidate({ ...candidate, inputTokens: 1_000_001 })).toMatchObject({
      accepted: false,
      reason: "REQUEST_TOO_LARGE",
    });
    expect(evaluateCompactionCandidate({ ...candidate, inputTokens: 900_000 })).toMatchObject({
      accepted: false,
      reason: "INSUFFICIENT_REDUCTION",
    });
  });

  it("rejects a candidate that removes content below the proven protected floor", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 30_000,
      recentTokens: 40_000,
      protectedRecentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_096,
      availableInputTokens: 1_000_000,
    });

    expect(
      evaluateCompactionCandidate({
        inputTokens: 49_999,
        inputTokensBefore: 900_000,
        compressibleTokens: 800_000,
        minimumReleaseRatio: 0.7,
        minimumLegalCut: false,
        budget,
      }),
    ).toMatchObject({ accepted: false, reason: "PROTECTED_CONTENT_MISSING" });
  });
});
