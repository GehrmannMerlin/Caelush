import { describe, expect, it } from "vitest";

import { createCompactionCandidate } from "./support/deep-compaction-fixtures.js";

describe("deep compaction retention budget", () => {
  it("uses_full_retention_budget_instead_of_soft_80_percent", async () => {
    const candidates = [
      { inputTokens: 44_192, accepted: true },
      { inputTokens: 800_000, accepted: false },
      { inputTokens: 880_000, accepted: false },
    ] as const;

    for (const candidate of candidates) {
      const { coordinator, request } = createCompactionCandidate({
        estimatedInputTokensAfter: candidate.inputTokens,
      });
      const outcome = await coordinator.compact(request);
      expect(outcome).toMatchObject({ kind: candidate.accepted ? "COMPACTED" : "NOT_APPLICABLE" });
      expect({
        inputTokens: candidate.inputTokens,
        accepted: outcome.kind === "COMPACTED",
      }).toEqual({ inputTokens: candidate.inputTokens, accepted: candidate.accepted });
    }
  });
});
