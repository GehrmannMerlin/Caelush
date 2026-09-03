import { describe, expect, it } from "vitest";
import { createModelContextProfile } from "../src/model-context-profile.js";
import {
  createContextPolicy,
  shouldEmergencyCompact,
  shouldProactivelyCompact,
} from "../src/context-policy.js";

function makeProfile(contextWindowTokens: number) {
  return createModelContextProfile({
    providerId: "fixture",
    modelId: "fixture",
    contextWindowTokens,
    maxOutputTokens: 16_384,
    recommendedOutputReserveTokens: 4096,
    supportsPromptCaching: false,
    supportsUsageReporting: true,
    profileSource: "CONFIGURATION",
  });
}

describe("ContextPolicy", () => {
  it.each([16_000, 32_000, 128_000])(
    "derives bounded elastic budgets for a %i-token profile",
    (contextWindowTokens) => {
      const policy = createContextPolicy(makeProfile(contextWindowTokens));

      expect(policy.effectiveInputLimit).toBe(contextWindowTokens - 4096 - 512);
      expect(policy.targetRecentTailTokens).toBe(
        Math.min(20_000, Math.floor(policy.effectiveInputLimit * 0.35)),
      );
      expect(policy.minRecentTailTokens).toBe(
        Math.min(8000, Math.floor(policy.effectiveInputLimit * 0.15)),
      );
      expect(policy.maxSingleObservationTokens).toBe(
        Math.min(8192, Math.floor(policy.effectiveInputLimit * 0.1)),
      );
      expect(policy.minRecentTailTokens).toBeLessThanOrEqual(policy.targetRecentTailTokens);
    },
  );

  it("keeps pressure triggers separate from the agent lifetime budget", () => {
    const policy = createContextPolicy(makeProfile(32_000), {
      proactiveCompactionRatio: 0.75,
      emergencyCompactionRatio: 0.9,
    });
    expect(policy.proactiveCompactionTokens).toBe(Math.floor(policy.effectiveInputLimit * 0.75));
    expect(policy.emergencyCompactionTokens).toBe(Math.floor(policy.effectiveInputLimit * 0.9));
    expect(shouldProactivelyCompact(policy.proactiveCompactionTokens, policy)).toBe(true);
    expect(shouldEmergencyCompact(policy.emergencyCompactionTokens, policy)).toBe(true);
  });

  it("rejects unsafe reserve and pressure configuration", () => {
    expect(() => createContextPolicy(makeProfile(16_000), { safetyReserveTokens: 20_000 })).toThrow(
      /safetyReserveTokens/,
    );
    expect(() =>
      createContextPolicy(makeProfile(16_000), {
        proactiveCompactionRatio: 0.95,
        emergencyCompactionRatio: 0.9,
      }),
    ).toThrow(/pressure ratios/);
  });
});
