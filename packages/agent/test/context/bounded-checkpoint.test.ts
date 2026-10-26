import { describe, expect, it } from "vitest";

import { fitStructuredCheckpointToBudget } from "@caelush/agent";
import { createStructuredCheckpoint } from "@caelush/agent";
import { createUtf8HeuristicTokenEstimator } from "@caelush/agent";

const MODEL = {
  ref: { provider: "test", model: "bounded-checkpoint" },
  api: "test-api",
  limits: { contextWindowTokens: 32_000, maxOutputTokens: 1_024 },
  capabilities: {
    streaming: "SUPPORTED" as const,
    toolCalling: "SUPPORTED" as const,
    parallelToolCalls: "UNKNOWN" as const,
    structuredOutput: "UNKNOWN" as const,
    vision: "UNKNOWN" as const,
    reasoning: "UNKNOWN" as const,
    reasoningSummary: "UNKNOWN" as const,
    promptCaching: "UNKNOWN" as const,
    usageReporting: "UNKNOWN" as const,
  },
  source: "CONFIGURATION" as const,
};

function checkpoint(overrides: Partial<Parameters<typeof createStructuredCheckpoint>[0]> = {}) {
  return createStructuredCheckpoint({
    version: 1,
    goal: "authoritative goal",
    constraints: ["Never expose secrets."],
    completedWork: Array.from(
      { length: 30 },
      (_, index) => `completed-${index}-${"x".repeat(300)}`,
    ),
    inProgress: ["Current active operation"],
    blocked: ["Waiting for user approval"],
    importantDiscoveries: ["Keep this recent discovery."],
    keyDecisions: ["Use the canonical storage transaction."],
    changedFiles: ["src/authority.ts"],
    readFiles: ["src/policy.ts"],
    recentErrors: ["safe error code"],
    verificationState: "CURRENT",
    activeProcesses: ["process:build"],
    pendingApprovals: ["approval:1"],
    resourceGovernance: "bounded",
    criticalReferences: ["message:1"],
    nextIntent: "Continue the current operation.",
    sourceRange: { from: 1, to: 10 },
    ...overrides,
  });
}

describe("bounded structured checkpoint", () => {
  it("fits compactable semantic memory while preserving authoritative facts and constraints", () => {
    const input = checkpoint();
    const result = fitStructuredCheckpointToBudget({
      checkpoint: input,
      maxTokens: 320,
      model: MODEL,
    });

    expect(result.constraints).toEqual(input.constraints);
    expect(result.goal).toBe(input.goal);
    expect(result.changedFiles).toEqual(input.changedFiles);
    expect(result.readFiles).toEqual(input.readFiles);
    expect(result.verificationState).toBe(input.verificationState);
    expect(result.pendingApprovals).toEqual(input.pendingApprovals);
    expect(result.completedWork.length).toBeLessThan(input.completedWork.length);
    expect(
      createUtf8HeuristicTokenEstimator().estimateText(JSON.stringify(result), MODEL),
    ).toBeLessThanOrEqual(320);
  });

  it("fails closed when mandatory host facts alone exceed the checkpoint ceiling", () => {
    const input = checkpoint({
      completedWork: [],
      inProgress: [],
      importantDiscoveries: [],
      keyDecisions: [],
      nextIntent: "",
      changedFiles: ["critical-".repeat(3_000)],
    });

    expect(() =>
      fitStructuredCheckpointToBudget({ checkpoint: input, maxTokens: 10, model: MODEL }),
    ).toThrow(/mandatory checkpoint data exceeds/i);
  });
});
