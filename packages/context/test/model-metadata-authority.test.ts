import { describe, expect, it } from "vitest";
import {
  createModelContextProfile,
  projectModelContextProfile,
  resolveModelContextProfile,
} from "../src/model-context-profile.js";

/**
 * Phase 2C model technical metadata authority.
 *
 * `ModelDescriptor` (the AI core) is the single authority for the model's intrinsic
 * limits and capabilities. `ModelContextProfile` is a compatibility projection for the
 * Context runtime's existing consumers. The two fields that are *not* model intrinsics —
 * `recommendedOutputReserveTokens` and `toolOutputSoftLimitTokens` — are Context policy
 * and must never be attributed to a descriptor.
 */

/** A legacy deployment's own idea of the model window. */
const LEGACY_PROFILE = createModelContextProfile({
  providerId: "fixture",
  modelId: "fixture-model",
  contextWindowTokens: 16_000,
  maxOutputTokens: 4_096,
  recommendedOutputReserveTokens: 2_048,
  supportsPromptCaching: true,
  supportsUsageReporting: true,
  profileSource: "CONFIGURATION",
});

/** What the AI core actually says about the same model. */
const DESCRIPTOR = {
  ref: { provider: "fixture", model: "fixture-model" },
  limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
  capabilities: { promptCaching: "UNKNOWN" as const, usageReporting: "SUPPORTED" as const },
  source: "CONFIGURATION",
};

describe("Context model metadata authority", () => {
  it("takes intrinsic limits from the descriptor even when a legacy profile disagrees", () => {
    const projected = projectModelContextProfile({
      descriptor: DESCRIPTOR,
      recommendedOutputReserveTokens: 2_048,
    });

    // The descriptor wins: the legacy 16_000/4_096 pair has no authority.
    expect(projected).toMatchObject({
      providerId: "fixture",
      modelId: "fixture-model",
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
    });
    expect(projected.contextWindowTokens).not.toBe(LEGACY_PROFILE.contextWindowTokens);
    expect(projected.maxOutputTokens).not.toBe(LEGACY_PROFILE.maxOutputTokens);
  });

  it("keeps the output reserve and tool-output limit policy-owned, never descriptor-owned", () => {
    const projected = projectModelContextProfile({
      descriptor: DESCRIPTOR,
      recommendedOutputReserveTokens: 3_072,
      toolOutputSoftLimitTokens: 12_000,
    });

    // Both values come from the caller's policy configuration. Nothing in the
    // descriptor can supply or override them, and neither is a model intrinsic.
    expect(projected.recommendedOutputReserveTokens).toBe(3_072);
    expect(projected.toolOutputSoftLimitTokens).toBe(12_000);
    expect(Object.keys(DESCRIPTOR.limits)).not.toContain("recommendedOutputReserveTokens");
    expect(Object.keys(DESCRIPTOR.limits)).not.toContain("toolOutputSoftLimitTokens");
  });

  it("never promotes an UNKNOWN capability to a guarantee", () => {
    const projected = projectModelContextProfile({
      descriptor: DESCRIPTOR,
      recommendedOutputReserveTokens: 2_048,
    });

    // `promptCaching: "UNKNOWN"` is not evidence of support, so it fails closed.
    expect(projected.supportsPromptCaching).toBe(false);
    // An explicit SUPPORTED is the only thing that becomes true.
    expect(projected.supportsUsageReporting).toBe(true);
  });

  it("marks a FALLBACK descriptor as a fallback rather than as configured metadata", () => {
    const projected = projectModelContextProfile({
      descriptor: { ...DESCRIPTOR, source: "FALLBACK" },
      recommendedOutputReserveTokens: 2_048,
    });
    expect(projected.profileSource).toBe("FALLBACK");
  });

  it("still resolves a legacy profile when no descriptor is available", () => {
    // The compatibility path is retained for callers that have no descriptor yet; it is
    // simply no longer what a descriptor-bearing caller uses.
    const resolved = resolveModelContextProfile({
      providerId: "fixture",
      modelId: "fixture-model",
      configuredProfiles: [LEGACY_PROFILE],
    });
    expect(resolved.contextWindowTokens).toBe(16_000);
    expect(resolved.profileSource).toBe("CONFIGURATION");
  });
});
