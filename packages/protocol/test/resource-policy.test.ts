import {
  CreateRunRequestSchema,
  DefaultRunConfigurationSchema,
  RunResourcePolicySchema,
  createLegacyRunResourcePolicy,
  normalizeCreateRunResourcePolicy,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const adaptivePolicy = {
  mode: "ADAPTIVE" as const,
  operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
  batch: { maxToolCallsPerTurn: 16 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: {
    maxTokens: 100_000,
    maxCost: 20,
    maxWallClockMs: 3_600_000,
  },
  inactivity: { nudgeAfterMs: 30_000, pauseAfterMs: 300_000 },
};

describe("RunResourcePolicy", () => {
  it("accepts a complete adaptive policy and rejects unsafe values", () => {
    expect(RunResourcePolicySchema.parse(adaptivePolicy)).toEqual(adaptivePolicy);
    expect(
      RunResourcePolicySchema.safeParse({
        ...adaptivePolicy,
        operationalLease: { maxAgentTurns: 0, maxToolOperations: 64 },
      }).success,
    ).toBe(false);
    expect(
      RunResourcePolicySchema.safeParse({
        ...adaptivePolicy,
        inactivity: { pauseAfterMs: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });

  it("maps legacy limits to an explicit legacy fixed policy", () => {
    const legacy = { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000, maxCost: 2 };
    expect(createLegacyRunResourcePolicy(legacy)).toMatchObject({
      mode: "LEGACY_FIXED",
      operationalLease: { maxAgentTurns: 8, maxToolOperations: 8 },
      hardLimits: { maxAgentTurns: 8, maxToolCalls: 8, maxCost: 2 },
    });
  });

  it("normalizes canonical and legacy create-run payloads without ambiguity", () => {
    const base = {
      goal: "scan",
      workspace: { id: "wsp_123456789012345678901234", path: "/workspace" },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "READ_ONLY" as const,
      approvalPolicy: "ALWAYS_ASK" as const,
    };
    const canonical = normalizeCreateRunResourcePolicy({ ...base, resourcePolicy: adaptivePolicy });
    expect(canonical.mode).toBe("ADAPTIVE");
    const legacy = normalizeCreateRunResourcePolicy({
      ...base,
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    });
    expect(legacy.mode).toBe("LEGACY_FIXED");
    expect(CreateRunRequestSchema.safeParse({ ...base }).success).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...base,
        limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
        resourcePolicy: adaptivePolicy,
      }).success,
    ).toBe(false);
  });

  it("intersects request hard limits with the enterprise ceiling", () => {
    const result = normalizeCreateRunResourcePolicy(
      { resourcePolicy: adaptivePolicy },
      {
        maxToolCalls: 50,
        maxCost: 20,
      },
    );
    expect(result.hardLimits.maxToolCalls).toBe(50);
    expect(result.hardLimits.maxCost).toBe(20);
  });

  it("accepts an adaptive policy in the daemon default configuration", () => {
    const configuration = {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "DANGEROUS_ONLY" as const,
      resourcePolicy: adaptivePolicy,
    };
    expect(DefaultRunConfigurationSchema.parse(configuration)).toEqual(configuration);
  });
});
