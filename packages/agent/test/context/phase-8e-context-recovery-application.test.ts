import { describe, expect, it } from "vitest";

import {
  createContextItemId,
  createContextSourceId,
  type ContextItem,
} from "../../src/context/item/context-item.js";
import { applyContextRecoveryToPlan } from "../../src/context/compaction/context-recovery-application.js";
import type { ContextPlan } from "../../src/context/policy/context-policy.js";

type ItemOptions = Partial<Omit<ContextItem, "source">> & {
  readonly source?: { readonly providerId?: string };
};

function item(id: string, options: ItemOptions = {}): ContextItem {
  return {
    id: createContextItemId(id),
    type: "TEXT",
    source: {
      providerId: createContextSourceId(options.source?.providerId ?? "optional"),
      sourceRef: id,
      version: "1",
    },
    scope: "RUN",
    retention: options.retention ?? "RETRIEVABLE",
    priorityClass: options.priorityClass ?? "LOW",
    tokenEstimate: options.tokenEstimate ?? 10,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "PUBLIC",
    ...(options.atomicGroupId === undefined ? {} : { atomicGroupId: options.atomicGroupId }),
    whyLoaded: "test",
    payload: { kind: "TEXT", text: id },
  };
}

function plan(items: readonly ContextItem[]): ContextPlan {
  return {
    selectedItems: items,
    decisions: items.map((value) => ({
      itemId: value.id,
      disposition: "SELECTED" as const,
      reason: "PRIORITY" as const,
      tokenEstimate: value.tokenEstimate,
    })),
    budget: {
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
      safetyReserveTokens: 10,
      requestOverheadTokens: 0,
      effectiveInputLimitTokens: 890,
      mandatoryTokens: 0,
      selectedTokens: items.reduce((total, value) => total + value.tokenEstimate, 0),
      remainingTokens: 890 - items.reduce((total, value) => total + value.tokenEstimate, 0),
    },
    pressure: "NORMAL",
    requiresCompaction: false,
  };
}

describe("Phase 8E recovery application", () => {
  it("defers only optional low retrievable atomic groups and recomputes the budget", () => {
    const optionalA = item("a", { atomicGroupId: "group-a", tokenEstimate: 20 });
    const optionalB = item("b", { atomicGroupId: "group-a", tokenEstimate: 30 });
    const required = item("required", {
      source: { providerId: "required" },
      retention: "RETRIEVABLE",
    });
    const optionalOther = item("optional-other", {
      retention: "REHYDRATABLE",
      priorityClass: "HIGH",
      tokenEstimate: 5,
    });
    const current = item("current", { retention: "RECENT", priorityClass: "HIGH" });
    const basePlan = plan([optionalA, optionalB, required, current, optionalOther]);
    const result = applyContextRecoveryToPlan({
      plan: {
        ...basePlan,
        decisions: basePlan.decisions.map((decision) =>
          decision.itemId === current.id ? { ...decision, reason: "RECENT" as const } : decision,
        ),
      },
      items: [optionalA, optionalB, required, current, optionalOther],
      actions: ["DEFER_LOW_RETRIEVABLE", "REDUCE_OPTIONAL_SOURCES"],
      sourceCriticality: { optional: "OPTIONAL", required: "REQUIRED" },
    });

    expect(result.selectedItems.map((value) => value.id)).toEqual([required.id, current.id]);
    expect(result.decisions.filter((value) => value.itemId === optionalA.id)[0]).toMatchObject({
      disposition: "DEFERRED",
      reason: "RETRIEVABLE_DEFERRED",
    });
    expect(result.decisions.filter((value) => value.itemId === optionalB.id)[0]).toMatchObject({
      disposition: "DEFERRED",
      reason: "RETRIEVABLE_DEFERRED",
    });
    expect(result.budget.selectedTokens).toBe(20);
    expect(result.budget.remainingTokens).toBe(870);
    expect(result.decisions.find((value) => value.itemId === optionalOther.id)).toMatchObject({
      disposition: "DROPPED",
      reason: "TOTAL_BUDGET",
    });
  });

  it("does not reduce a protected group even when its source is optional", () => {
    const openUnit = item("open", {
      source: { providerId: "optional" },
      atomicGroupId: "open-group",
    });
    const input = plan([openUnit]);
    const protectedInput: ContextPlan = {
      ...input,
      decisions: [{ ...input.decisions[0]!, reason: "OPEN_PROTOCOL_UNIT" }],
    };
    const result = applyContextRecoveryToPlan({
      plan: protectedInput,
      items: [openUnit],
      actions: ["DEFER_LOW_RETRIEVABLE", "REDUCE_OPTIONAL_SOURCES"],
      sourceCriticality: { optional: "OPTIONAL" },
    });

    expect(result.selectedItems).toHaveLength(1);
    expect(result.decisions[0]?.disposition).toBe("SELECTED");
  });
});
