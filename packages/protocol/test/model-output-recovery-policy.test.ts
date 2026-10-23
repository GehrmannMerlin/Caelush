import * as protocol from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const legacyRun = {
  id: protocol.createRunId(),
  sessionId: protocol.createSessionId(),
  goal: "verify the project",
  status: "PENDING" as const,
  workspace: { id: protocol.createWorkspaceId(), path: "D:/workspace" },
  model: { provider: "local", model: "test-model" },
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS" as const,
  approvalPolicy: "DANGEROUS_ONLY" as const,
  limits: { maxSteps: 10, maxToolCalls: 20, timeoutMs: 30_000 },
  createdAt: 1_700_000_000_000,
};

describe("bounded model output recovery protocol contract", () => {
  it("round-trips a historical Run without adding a recovery policy", () => {
    expect(protocol.AgentRunSchema.parse(JSON.parse(JSON.stringify(legacyRun)))).toEqual(legacyRun);
    expect(legacyRun).not.toHaveProperty("contextBudgetPolicy");
  });

  it("allows the single fixed recovery policy only on TURN_BUDGET_V3", () => {
    const policy = {
      version: "TURN_BUDGET_V3",
      algorithm: "HEADROOM_V1",
      minOutputTokens: 1_024,
      preferredOutputTokens: 16_384,
      safetyTokens: 2_048,
      expectedGrowthTokens: 4_096,
      postCompactionRatio: 0.5,
      outputRecovery: {
        version: "OUTPUT_RECOVERY_V1",
        maxRecoveryTurns: 1,
        outputMultiplier: 2,
      },
    } as const;

    expect(
      protocol.AgentRunSchema.safeParse({ ...legacyRun, contextBudgetPolicy: policy }).success,
    ).toBe(true);
    const policyWithoutRecovery = {
      version: "TURN_BUDGET_V3",
      algorithm: "HEADROOM_V1",
      minOutputTokens: 1_024,
      preferredOutputTokens: 16_384,
      safetyTokens: 2_048,
      expectedGrowthTokens: 4_096,
      postCompactionRatio: 0.5,
    } as const;
    expect(
      protocol.AgentRunSchema.parse({
        ...legacyRun,
        contextBudgetPolicy: policyWithoutRecovery,
      }),
    ).toEqual({ ...legacyRun, contextBudgetPolicy: policyWithoutRecovery });
    expect(
      protocol.AgentRunSchema.safeParse({
        ...legacyRun,
        contextBudgetPolicy: {
          ...policy,
          outputRecovery: { ...policy.outputRecovery, maxRecoveryTurns: 2 },
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.AgentRunSchema.safeParse({
        ...legacyRun,
        contextBudgetPolicy: {
          ...policy,
          outputRecovery: { ...policy.outputRecovery, outputMultiplier: 3 },
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.AgentRunSchema.safeParse({
        ...legacyRun,
        contextBudgetPolicy: {
          version: "LEGACY_FULL_OUTPUT_V1",
          outputRecovery: policy.outputRecovery,
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.AgentRunSchema.safeParse({
        ...legacyRun,
        contextBudgetPolicy: {
          ...policy,
          outputRecovery: { ...policy.outputRecovery, unexpected: true },
        },
      }).success,
    ).toBe(false);
  });

  it("adds the output-truncation code only to RETRY_WAIT", () => {
    const retryWait = {
      kind: "RETRY_WAIT" as const,
      nextAttemptAt: 300_000,
      attempt: 2,
      maxAttempts: 2,
      errorCode: "LLM_OUTPUT_TRUNCATED" as const,
    };
    const providerWait = {
      kind: "PROVIDER_WAIT" as const,
      nextAttemptAt: 300_000,
      episode: 2,
      errorCode: "LLM_OUTPUT_TRUNCATED",
    };

    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        process: retryWait,
      }).success,
    ).toBe(true);
    expect(
      protocol.ContextUsageProjectionSchema.safeParse({
        ...baseUsage,
        process: providerWait,
      }).success,
    ).toBe(false);
    for (const errorCode of ["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"] as const) {
      expect(
        protocol.ContextUsageProjectionSchema.safeParse({
          ...baseUsage,
          process: { ...retryWait, errorCode },
        }).success,
      ).toBe(true);
    }

    for (const invalidProcess of [
      { ...retryWait, attempt: 1 },
      { ...retryWait, maxAttempts: 3 },
      { ...retryWait, episode: 1 },
      { ...retryWait, totalAttempts: 1 },
    ]) {
      expect(
        protocol.ContextUsageProjectionSchema.safeParse({
          ...baseUsage,
          process: invalidProcess,
        }).success,
      ).toBe(false);
    }
  });
});

const baseUsage = {
  runId: legacyRun.id,
  providerId: "fixture-provider",
  modelId: "fixture-model",
  contextWindowTokens: 16_000,
  effectiveInputLimitTokens: 12_000,
  estimatedInputTokens: 4_000,
  usedRatio: 1 / 3,
  remainingTokens: 8_000,
  pressureState: "NORMAL" as const,
  compactionCount: 0,
  breakdown: {
    pinned: 500,
    checkpoint: 0,
    recentTail: 1_000,
    project: 0,
    files: 0,
    toolObservations: 0,
    memory: 0,
  },
  updatedAt: 1_700_000_000_000,
};
