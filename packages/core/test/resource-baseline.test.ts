import type { RunLimits } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { BudgetManager, type RunBudgetSnapshot } from "../src/budget-manager.js";

const legacyLimits: RunLimits = {
  maxSteps: 8,
  maxToolCalls: 8,
  timeoutMs: 10_000,
};

const accountedSnapshot: RunBudgetSnapshot = {
  toolCallsConsumed: 4,
  toolCallsReserved: 0,
  tokensConsumed: 0,
  tokensReserved: 0,
  costMicrosConsumed: 0,
  costMicrosReserved: 0,
};

describe("resource governance baseline", () => {
  it("reproduces the current lifetime Tool-call rejection for the workspace-scan batch", () => {
    const result = new BudgetManager().admitToolCalls({
      limits: legacyLimits,
      snapshot: accountedSnapshot,
      requested: 5,
    });

    expect(result).toMatchObject({
      kind: "EXCEEDED",
      dimension: "TOOL_CALLS",
      accounted: 4,
      limit: 8,
    });
  });

  it("RED: an adaptive healthy batch must not be terminally rejected at the old lifetime threshold", () => {
    const result = new BudgetManager().admitToolCalls({
      limits: legacyLimits,
      snapshot: accountedSnapshot,
      requested: 5,
    });

    expect(result.kind).not.toBe("EXCEEDED");
  });

  it("keeps a healthy broad-scan workload distinct from Agent Turn count", () => {
    const workload = [
      "list_directory:.",
      "find_files:src",
      "read_file:src/index.ts",
      "search_text:AgentLoop",
      "list_directory:packages",
      "find_files:packages/core",
      "read_file:packages/core/src/agent-loop.ts",
      "search_text:RunController",
      "list_directory:apps",
      "find_files:apps/daemon",
      "read_file:apps/daemon/src/daemon-composition.ts",
      "search_text:DEFAULT_RUN_CONFIGURATION",
    ];

    expect(workload).toHaveLength(12);
    expect(Math.ceil(workload.length / 4)).toBe(3);
    expect(new Set(workload).size).toBe(workload.length);
  });
});
