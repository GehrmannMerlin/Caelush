import { describe, expect, it } from "vitest";
import {
  createModelContextProfile,
  resolveModelContextProfile,
  type ModelContextProfile,
} from "../src/model-context-profile.js";

function profile(contextWindowTokens: number): ModelContextProfile {
  return createModelContextProfile({
    providerId: "fixture",
    modelId: `fixture-${contextWindowTokens}`,
    contextWindowTokens,
    maxOutputTokens: 4096,
    recommendedOutputReserveTokens: 2048,
    supportsPromptCaching: true,
    supportsUsageReporting: true,
    profileSource: "CONFIGURATION",
  });
}

describe("ModelContextProfile", () => {
  it("preserves explicit configuration and records its provenance", () => {
    const configured = profile(16_000);
    const resolved = resolveModelContextProfile({
      providerId: configured.providerId,
      modelId: configured.modelId,
      configuredProfiles: [configured],
    });

    expect(resolved).toEqual(configured);
    expect(resolved.profileSource).toBe("CONFIGURATION");
  });

  it("uses a deterministic safe fallback when no local metadata matches", () => {
    const resolved = resolveModelContextProfile({
      providerId: "deepseek",
      modelId: "deepseek/deepseek-v4-flash",
      fallback: {
        contextWindowTokens: 16_000,
        maxOutputTokens: 4096,
        recommendedOutputReserveTokens: 2048,
      },
    });

    expect(resolved.contextWindowTokens).toBe(16_000);
    expect(resolved.profileSource).toBe("FALLBACK");
    expect(resolved.providerId).toBe("deepseek");
  });

  it("does not mutate a supplied profile catalog", () => {
    const configured = profile(128_000);
    const catalog = [configured];
    const resolved = resolveModelContextProfile({
      providerId: "fixture",
      modelId: "fixture-128000",
      configuredProfiles: catalog,
    });

    expect(resolved).not.toBe(configured);
    expect(catalog).toEqual([configured]);
  });
});
