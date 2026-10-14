import {
  AgentRunSchema,
  CurrentAgentRunSchema,
  computeSecurityPolicyDigest,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const securityPolicyBody = {
  schemaVersion: 1 as const,
  preset: { id: "VIEW_ONLY" as const, version: 1 as const },
  permissionProfile: "READ_ONLY" as const,
  approvalPolicy: "ON_BOUNDARY" as const,
  filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
  processBoundary: "READ_ONLY" as const,
  requiredEnforcement: "OS_RESTRICTED" as const,
  hardSafetyPolicyVersion: "hard-safety@1",
  commandPolicyVersion: "command-policy@1",
  secretPolicyVersion: "secret-policy@1",
  createdAt: new Date(100).toISOString(),
};

const baseRun = {
  id: createRunId(),
  sessionId: createSessionId(),
  goal: "test goal",
  status: "PENDING" as const,
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  permissionProfile: "READ_ONLY" as const,
  approvalPolicy: "ON_BOUNDARY" as const,
  limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 1_000 },
  createdAt: createTimestampMs(100),
  securityPolicy: {
    ...securityPolicyBody,
    policyDigest: computeSecurityPolicyDigest(securityPolicyBody),
  },
};

describe("Run context budget policy snapshot", () => {
  it("accepts only a valid, closed adaptive snapshot on new Run writes", () => {
    const snapshot = {
      version: "ADAPTIVE_V1",
      outputReserveTokens: 16_384,
      safetyReserveTokens: 4_096,
    } as const;

    expect(
      CurrentAgentRunSchema.safeParse({ ...baseRun, contextBudgetPolicy: snapshot }).success,
    ).toBe(true);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { ...snapshot, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { ...snapshot, outputReserveTokens: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { ...snapshot, safetyReserveTokens: -1 },
      }).success,
    ).toBe(false);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { ...snapshot, outputReserveTokens: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { ...snapshot, version: "ADAPTIVE_V2" },
      }).success,
    ).toBe(false);
  });

  it("requires the snapshot on new writes while decoding historical Runs without it", () => {
    expect(CurrentAgentRunSchema.safeParse(baseRun).success).toBe(false);
    expect(AgentRunSchema.safeParse(baseRun).success).toBe(true);
  });

  it("accepts a closed legacy policy on new Runs while the adaptive cache gate is inconclusive", () => {
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { version: "LEGACY_FULL_OUTPUT_V1" },
      }).success,
    ).toBe(true);
    expect(
      CurrentAgentRunSchema.safeParse({
        ...baseRun,
        contextBudgetPolicy: { version: "LEGACY_FULL_OUTPUT_V1", outputReserveTokens: 1 },
      }).success,
    ).toBe(false);
  });
});
