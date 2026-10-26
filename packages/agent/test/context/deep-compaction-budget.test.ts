import { describe, expect, it } from "vitest";

import {
  createContextPolicy,
  DEEP_COMPACTION_V2_DEFAULTS,
  resolveCompactionRetentionBudget,
  resolveTurnBudgetPolicy,
  type ContextCompactionRequest,
} from "@caelush/agent";
import { evaluateCompactionCandidate } from "../../src/context/compaction/compaction-retention-budget.js";
import type { ModelDescriptor } from "@caelush/ai";
import { createCompactionCandidate } from "./support/deep-compaction-fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "deep-compaction-budget" },
  api: "test-api",
  limits: { contextWindowTokens: 1_000_000, maxOutputTokens: 16_384 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

describe("deep compaction retention budget", () => {
  it("does not let the legacy 15% minimum override the elastic recent ratio", () => {
    const policy = createContextPolicy({
      model: MODEL,
      options: {
        requestHeadroom: { expectedGrowthTokens: 16_384 },
        deepCompaction: DEEP_COMPACTION_V2_DEFAULTS,
      },
    });

    expect(policy.targetRecentTailTokens).toBeLessThan(policy.effectiveInputLimitTokens * 0.1);
    expect(policy.minRecentTailTokens).toBe(0);
  });

  it.each([128 * 1024, 256 * 1024, 1_000_000])(
    "keeps the soft target, release threshold, growth reserve, and hard ceiling separate at %i tokens",
    (contextWindowTokens) => {
      const model: ModelDescriptor = {
        ...MODEL,
        limits: { contextWindowTokens, maxOutputTokens: 16_384 },
      };
      const headroom = resolveTurnBudgetPolicy({
        contextWindowTokens,
        maxOutputTokens: model.limits.maxOutputTokens,
      });
      const policy = createContextPolicy({
        model,
        options: { requestHeadroom: headroom, deepCompaction: DEEP_COMPACTION_V2_DEFAULTS },
      });
      const fixedTokens = 12_000;
      const protectedRecentTokens = 8_000;
      const recentTokens = Math.floor(
        (policy.effectiveInputLimitTokens - fixedTokens) * DEEP_COMPACTION_V2_DEFAULTS.recentRatio,
      );
      const budget = resolveCompactionRetentionBudget({
        fixedTokens,
        recentTokens,
        protectedRecentTokens,
        checkpointMaxTokens: DEEP_COMPACTION_V2_DEFAULTS.checkpointMaxTokens,
        boundaryTokens: DEEP_COMPACTION_V2_DEFAULTS.boundaryTokens,
        availableInputTokens:
          policy.effectiveInputLimitTokens - policy.requestHeadroom!.expectedGrowthTokens,
      });
      const inputTokensBefore = policy.effectiveInputLimitTokens;
      const compressibleTokens = inputTokensBefore - fixedTokens - protectedRecentTokens;
      const inputTokens = Math.max(
        budget.targetInputTokens + 1,
        inputTokensBefore -
          Math.ceil(compressibleTokens * DEEP_COMPACTION_V2_DEFAULTS.minimumReleaseRatio),
      );
      const evaluation = evaluateCompactionCandidate({
        inputTokens,
        inputTokensBefore,
        compressibleTokens,
        minimumReleaseRatio: DEEP_COMPACTION_V2_DEFAULTS.minimumReleaseRatio,
        minimumLegalCut: false,
        protectedContentRetained: true,
        budget,
      });

      expect(inputTokens).toBeGreaterThan(budget.targetInputTokens);
      expect(inputTokens).toBeLessThanOrEqual(budget.availableInputTokens);
      expect(evaluation).toMatchObject({ accepted: true, status: "ELASTIC" });
      expect(evaluation.actualFreedTokens).toBeGreaterThanOrEqual(
        Math.ceil(compressibleTokens * DEEP_COMPACTION_V2_DEFAULTS.minimumReleaseRatio),
      );
    },
  );

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

  it("does not let the next-turn reserve weaken the minimum release on forced recovery", async () => {
    const { coordinator, request } = createCompactionCandidate({
      estimatedInputTokensAfter: 900_000,
    });

    const outcome = await coordinator.compact({
      ...request,
      reason: "FORCED_PROVIDER_OVERFLOW",
      policy: {
        ...request.policy,
        requestHeadroom: { expectedGrowthTokens: 16_384 },
        deepCompaction: DEEP_COMPACTION_V2_DEFAULTS,
      } as ContextCompactionRequest["policy"],
    });

    // The candidate saves 30K tokens and fits the hard ceiling, but releases far less than
    // the configured 70% of compressible history. A growth reserve cannot replace that goal.
    expect(outcome).toMatchObject({ kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_REDUCTION" });
  });
});
