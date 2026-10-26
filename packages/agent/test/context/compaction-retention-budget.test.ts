import { describe, expect, it } from "vitest";

import {
  acceptCompactionCandidate,
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
      targetStatus: "DEEP",
    });
    expect(acceptCompactionCandidate({ inputTokens: 44_192, budget })).toBe(true);
    expect(acceptCompactionCandidate({ inputTokens: 800_000, budget })).toBe(false);
    expect(acceptCompactionCandidate({ inputTokens: 880_000, budget })).toBe(false);
  });

  it("reports floor-limited when mandatory input consumes the available window", () => {
    const budget = resolveCompactionRetentionBudget({
      fixedTokens: 48_000,
      recentTokens: 20_000,
      checkpointMaxTokens: 8_192,
      boundaryTokens: 4_000,
      availableInputTokens: 50_000,
    });

    expect(budget.targetStatus).toBe("FLOOR_LIMITED");
    expect(budget.targetInputTokens).toBe(50_000);
    expect(acceptCompactionCandidate({ inputTokens: 50_001, budget })).toBe(false);
  });
});
