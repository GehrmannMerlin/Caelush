import { describe, expect, it } from "vitest";

import {
  createContextCheckpointBudgetResolver,
  createContextCompactionGainEvaluator,
  type ContextCompactionPlan,
  type ContextPolicy,
} from "@caelush/agent";

function policy(effectiveInputLimitTokens: number): ContextPolicy {
  return { effectiveInputLimitTokens } as ContextPolicy;
}

function plan(selectedTokens: number): ContextCompactionPlan {
  return { selectedTokens } as ContextCompactionPlan;
}

describe("Phase 8B checkpoint budget and compaction gain", () => {
  it("derives a positive target/max budget below the selected source", () => {
    const budget = createContextCheckpointBudgetResolver().resolve({
      policy: policy(5_000),
      plan: plan(1_000),
    });

    expect(budget.targetTokens).toBeGreaterThan(0);
    expect(budget.maxTokens).toBeGreaterThan(0);
    expect(budget.targetTokens).toBeLessThanOrEqual(budget.maxTokens);
    expect(budget.maxTokens).toBeLessThan(1_000);
  });

  it("caps the checkpoint budget for a large effective input", () => {
    const budget = createContextCheckpointBudgetResolver().resolve({
      policy: policy(200_000),
      plan: plan(30_000),
    });

    expect(budget.maxTokens).toBeLessThanOrEqual(8_192);
  });

  it("reports conservative gain using the maximum checkpoint estimate", () => {
    const evaluator = createContextCompactionGainEvaluator();
    expect(
      evaluator.evaluate({
        plan: plan(100),
        checkpointBudget: { targetTokens: 80, maxTokens: 95 },
      }),
    ).toEqual({
      selectedTokens: 100,
      estimatedCheckpointTokens: 95,
      estimatedFreedTokens: 5,
      gainRatio: 0.05,
    });
    expect(
      evaluator.evaluate({
        plan: plan(10_000),
        checkpointBudget: { targetTokens: 1_000, maxTokens: 2_000 },
      }).gainRatio,
    ).toBe(0.8);
  });

  it("fails closed for impossible source or budget values", () => {
    const resolver = createContextCheckpointBudgetResolver();
    expect(() => resolver.resolve({ policy: policy(0), plan: plan(100) })).toThrow(RangeError);
    expect(() => resolver.resolve({ policy: policy(1_000), plan: plan(0) })).toThrow(RangeError);
    expect(() =>
      createContextCompactionGainEvaluator().evaluate({
        plan: plan(100),
        checkpointBudget: { targetTokens: 0, maxTokens: 95 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createContextCompactionGainEvaluator().evaluate({
        plan: plan(100),
        checkpointBudget: { targetTokens: 96, maxTokens: 95 },
      }),
    ).toThrow(RangeError);
  });
});
