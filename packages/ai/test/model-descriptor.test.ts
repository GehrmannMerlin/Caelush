import { describe, expect, it } from "vitest";
import { CACHE_RETENTIONS, isCacheRetention } from "../src/cache/cache-retention.js";
import { isCapabilitySupport } from "../src/models/model-capabilities.js";
import { assertModelDescriptor } from "../src/models/model-descriptor.js";
import { MODEL_DESCRIPTOR_SOURCES } from "../src/models/model-descriptor-source.js";
import { assertModelLimits } from "../src/models/model-limits.js";
import { REASONING_LEVELS, reasoningLevelIndex } from "../src/reasoning/reasoning-level.js";
import type { JsonObject } from "../src/json/json-value.js";
import type { ModelCapabilities } from "../src/models/model-capabilities.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";

const capabilities: ModelCapabilities = {
  streaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNSUPPORTED",
  vision: "UNSUPPORTED",
  reasoning: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
  promptCaching: "UNSUPPORTED",
  usageReporting: "SUPPORTED",
};

/**
 * Build a descriptor literal.
 *
 * The override bag is loosely typed because most of this file asserts that
 * malformed descriptors are rejected, so the values under test cannot satisfy
 * `ModelDescriptor`.
 */
function descriptor(overrides: Record<string, unknown> = {}): ModelDescriptor {
  return {
    ref: { provider: "openai", model: "gpt-5" },
    api: "openai-compatible-chat",
    limits: { contextWindowTokens: 200_000, maxOutputTokens: 16_384 },
    capabilities,
    source: "CONFIGURATION",
    ...overrides,
  } as ModelDescriptor;
}

describe("ModelLimits", () => {
  it("accepts a consistent limit pair", () => {
    expect(() => {
      assertModelLimits({ contextWindowTokens: 1, maxOutputTokens: 1 });
    }).not.toThrow();
    expect(() => {
      assertModelLimits({ contextWindowTokens: 200_000, maxOutputTokens: 16_384 });
    }).not.toThrow();
  });

  it("rejects invalid values", () => {
    for (const limits of [
      undefined,
      null,
      {},
      { contextWindowTokens: 0, maxOutputTokens: 1 },
      { contextWindowTokens: 1, maxOutputTokens: 0 },
      { contextWindowTokens: -1, maxOutputTokens: 1 },
      { contextWindowTokens: 100, maxOutputTokens: 101 },
      { contextWindowTokens: 1.5, maxOutputTokens: 1 },
      { contextWindowTokens: 100, maxOutputTokens: 1.5 },
      { contextWindowTokens: Number.NaN, maxOutputTokens: 1 },
      { contextWindowTokens: 100, maxOutputTokens: Number.POSITIVE_INFINITY },
      { contextWindowTokens: "100", maxOutputTokens: 1 },
      { contextWindowTokens: 100, maxOutputTokens: 1, extra: true },
    ] as unknown[]) {
      expect(
        () => {
          assertModelLimits(limits);
        },
        JSON.stringify(limits) ?? "undefined",
      ).toThrow(TypeError);
    }
  });
});

describe("CapabilitySupport", () => {
  it("preserves UNKNOWN as a distinct third state", () => {
    expect(isCapabilitySupport("SUPPORTED")).toBe(true);
    expect(isCapabilitySupport("UNSUPPORTED")).toBe(true);
    expect(isCapabilitySupport("UNKNOWN")).toBe(true);
    expect(isCapabilitySupport("supported")).toBe(false);
    expect(isCapabilitySupport(undefined)).toBe(false);

    expect(capabilities.parallelToolCalls).toBe("UNKNOWN");
    expect(capabilities.structuredOutput).toBe("UNSUPPORTED");
  });
});

describe("ReasoningLevel", () => {
  it("keeps the frozen canonical order", () => {
    expect(REASONING_LEVELS).toEqual(["OFF", "MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"]);
    expect(REASONING_LEVELS.map(reasoningLevelIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(reasoningLevelIndex("UNKNOWN")).toBeUndefined();
  });
});

describe("CacheRetention", () => {
  it("keeps the frozen retention order", () => {
    expect(CACHE_RETENTIONS).toEqual(["NONE", "SHORT", "LONG"]);
    expect(isCacheRetention("LONG")).toBe(true);
    expect(isCacheRetention("MEDIUM")).toBe(false);
  });
});

describe("ModelDescriptorSource", () => {
  it("keeps the frozen precedence list", () => {
    expect(MODEL_DESCRIPTOR_SOURCES).toEqual([
      "CONFIGURATION",
      "BUILTIN",
      "PROVIDER_DEFAULT",
      "DISCOVERED",
      "FALLBACK",
    ]);
  });
});

describe("ModelDescriptor", () => {
  it("accepts the frozen descriptor shape", () => {
    expect(() => {
      assertModelDescriptor(
        descriptor({
          displayName: "GPT-5",
          reasoning: {
            supportedLevels: ["LOW", "MEDIUM"],
            defaultLevel: "LOW",
            supportsSummary: "SUPPORTED",
          },
          cache: { supportedRetentions: ["SHORT", "LONG"], defaultRetention: "SHORT" },
          adapterMetadata: { dialectVersion: 1, notes: ["a"] },
        }),
      );
    }).not.toThrow();
  });

  it("requires identity, dialect, limits, capabilities and a known source", () => {
    const invalid: unknown[] = [
      descriptor({ ref: undefined }),
      descriptor({ ref: { provider: "Openai", model: "gpt-5" } }),
      descriptor({ ref: { provider: "openai", model: "" } }),
      descriptor({ api: "OpenAI-Chat" }),
      descriptor({ api: "" }),
      descriptor({ capabilities: { ...capabilities, streaming: "MAYBE" } }),
      descriptor({ capabilities: { ...capabilities, parallelToolCalls: undefined } }),
      descriptor({ source: "GUESSED" }),
      descriptor({ displayName: "" }),
      descriptor({ limits: { contextWindowTokens: 10, maxOutputTokens: 11 } }),
      descriptor({ reasoning: { supportedLevels: ["MEDIUM", "LOW"], supportsSummary: "UNKNOWN" } }),
      descriptor({ reasoning: { supportedLevels: ["LOW", "LOW"], supportsSummary: "UNKNOWN" } }),
      descriptor({
        reasoning: { supportedLevels: ["LOW"], defaultLevel: "HIGH", supportsSummary: "UNKNOWN" },
      }),
      descriptor({ cache: { supportedRetentions: ["LONG", "SHORT"] } }),
      descriptor({ cache: { supportedRetentions: ["SHORT"], defaultRetention: "LONG" } }),
    ];

    for (const value of invalid) {
      expect(
        () => {
          assertModelDescriptor(value);
        },
        JSON.stringify(value) ?? "undefined",
      ).toThrow(TypeError);
    }
  });

  it("stays secret-free: adapter metadata may not carry connection or credential material", () => {
    for (const adapterMetadata of [
      { apiKey: "sk-x" },
      { api_key: "sk-x" },
      { API_KEY: "sk-x" },
      { authorization: "Bearer sk-x" },
      { bearerToken: "sk-x" },
      { token: "sk-x" },
      { secret: "sk-x" },
      { password: "sk-x" },
      { credential: { value: "sk-x" } },
      { credentials: [] },
      { headers: { "x-api-key": "sk-x" } },
      { queryParams: { key: "sk-x" } },
      { endpoint: "https://api.example" },
      { "x-api-key": "sk-x" },
      { nested: { deeper: { apiKey: "sk-x" } } },
      { list: [{ apiKey: "sk-x" }] },
    ] as unknown[]) {
      expect(() => {
        assertModelDescriptor(descriptor({ adapterMetadata: adapterMetadata as JsonObject }));
      }, JSON.stringify(adapterMetadata)).toThrow(TypeError);
    }
  });

  it("requires adapter metadata to be JSON-safe", () => {
    for (const adapterMetadata of [
      { fn: () => undefined },
      { value: Number.NaN },
      { value: undefined },
      { value: new Date() },
    ] as unknown[]) {
      expect(() => {
        assertModelDescriptor(descriptor({ adapterMetadata: adapterMetadata as JsonObject }));
      }).toThrow(TypeError);
    }
  });
});
