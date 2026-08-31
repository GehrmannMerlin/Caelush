import { describe, expect, it } from "vitest";
import { BudgetManager, type RunBudgetSnapshot } from "../src/budget-manager.js";
import { usdToCostMicros } from "../src/cost-micros.js";
import type { RunLimits } from "@caelush/protocol";

const snapshot: RunBudgetSnapshot = {
  toolCallsConsumed: 0,
  toolCallsReserved: 0,
  tokensConsumed: 0,
  tokensReserved: 0,
  costMicrosConsumed: 0,
  costMicrosReserved: 0,
};

const limits: RunLimits = { maxSteps: 10, maxToolCalls: 100, timeoutMs: 1_000 };

describe("BudgetManager", () => {
  it("admits an exact Tool-call boundary and blocks the next call", () => {
    const manager = new BudgetManager();
    expect(
      manager.admitToolCalls({
        limits: { ...limits, maxToolCalls: 100 },
        snapshot: { ...snapshot, toolCallsConsumed: 99 },
        requested: 1,
      }),
    ).toMatchObject({ kind: "ALLOWED", reservedToolCalls: 1 });
    expect(
      manager.admitToolCalls({
        limits: { ...limits, maxToolCalls: 100 },
        snapshot: { ...snapshot, toolCallsConsumed: 99 },
        requested: 2,
      }),
    ).toMatchObject({ kind: "EXCEEDED", dimension: "TOOL_CALLS", accounted: 99 });
  });

  it("clamps output to the lower token budget and rejects zero allowance", () => {
    const manager = new BudgetManager();
    expect(
      manager.admitLLM({
        limits: { ...limits, maxTokens: 100 },
        snapshot,
        estimatedInputTokens: 40,
        configuredMaxOutputTokens: 80,
      }),
    ).toMatchObject({ kind: "ALLOWED", effectiveMaxOutputTokens: 60, reservedOutputTokens: 60 });
    expect(
      manager.admitLLM({
        limits: { ...limits, maxTokens: 40 },
        snapshot,
        estimatedInputTokens: 40,
        configuredMaxOutputTokens: 1,
      }),
    ).toMatchObject({ kind: "EXCEEDED", dimension: "TOKENS" });
  });

  it("enforces token and cost limits together with conservative ceiling arithmetic", () => {
    const manager = new BudgetManager();
    const result = manager.admitLLM({
      limits: { ...limits, maxTokens: 100, maxCost: 0.0002 },
      snapshot,
      estimatedInputTokens: 10,
      configuredMaxOutputTokens: 100,
      pricing: {
        id: "fake-v1",
        currency: "USD",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      },
    });
    expect(result).toMatchObject({ kind: "ALLOWED", effectiveMaxOutputTokens: 90 });
    if (result.kind === "ALLOWED") {
      expect(result.reservedCostMicros).toBe(190);
    }
    expect(usdToCostMicros(0.0002)).toBe(200);
  });

  it("fails closed when maxCost is enabled without pricing", () => {
    expect(
      new BudgetManager().admitLLM({
        limits: { ...limits, maxCost: 1 },
        snapshot,
        estimatedInputTokens: 1,
      }),
    ).toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("allows zero-rate output without inventing a cost reservation", () => {
    expect(
      new BudgetManager().admitLLM({
        limits: { ...limits, maxCost: 1 },
        snapshot,
        estimatedInputTokens: 10,
        pricing: {
          id: "free",
          currency: "USD",
          inputMicrosPerMillionTokens: 0,
          outputMicrosPerMillionTokens: 0,
        },
      }),
    ).toMatchObject({ kind: "ALLOWED", reservedCostMicros: 0 });
  });
});
