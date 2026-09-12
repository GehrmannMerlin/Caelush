import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createModelCatalogBuilder } from "../src/models/model-catalog-builder.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";
import type { ModelDescriptorSource } from "../src/models/model-descriptor-source.js";
import type {
  EnumerableModelDescriptorSourcePort,
  ModelDescriptorSourcePort,
} from "../src/models/model-descriptor-source-port.js";
import type { ModelRef } from "../src/models/model-ref.js";

const REF: ModelRef = { provider: "openai", model: "gpt-5" };

const CAPABILITIES = {
  streaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoning: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
  promptCaching: "UNKNOWN",
  usageReporting: "SUPPORTED",
} as const;

function descriptor(
  source: ModelDescriptorSource,
  contextWindowTokens = 100_000,
  ref: ModelRef = REF,
): ModelDescriptor {
  return {
    ref,
    api: "openai-compatible-chat",
    limits: { contextWindowTokens, maxOutputTokens: Math.min(1_000, contextWindowTokens) },
    capabilities: { ...CAPABILITIES },
    source,
  };
}

/** A resolve-only source: the frozen three-member port, no enumeration. */
function source(
  id: string,
  priority: number,
  sourceKind: ModelDescriptorSource,
  contextWindowTokens = 100_000,
  ref: ModelRef = REF,
): ModelDescriptorSourcePort {
  return {
    id,
    priority,
    resolve: (requested) =>
      requested.provider === ref.provider && requested.model === ref.model
        ? descriptor(sourceKind, contextWindowTokens, requested)
        : undefined,
  };
}

/** An enumerable source: adds `list()` so the catalog can report a known set. */
function enumerableSource(
  id: string,
  priority: number,
  sourceKind: ModelDescriptorSource,
  refs: readonly ModelRef[],
): EnumerableModelDescriptorSourcePort {
  return {
    id,
    priority,
    resolve: (requested) =>
      refs.some((ref) => ref.provider === requested.provider && ref.model === requested.model)
        ? descriptor(sourceKind, 100_000, requested)
        : undefined,
    list: () => refs.map((ref) => descriptor(sourceKind, 100_000, ref)),
  };
}

describe("ModelCatalog precedence", () => {
  it("prefers the strongest descriptor source over a better priority", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(source("low", 100, "CONFIGURATION", 111))
      .registerSource(source("high", 0, "BUILTIN", 222))
      .build();

    expect(catalog.resolve(REF).source).toBe("CONFIGURATION");
    expect(catalog.resolve(REF).limits.contextWindowTokens).toBe(111);
  });

  it.each([
    ["CONFIGURATION", "BUILTIN"],
    ["BUILTIN", "PROVIDER_DEFAULT"],
    ["PROVIDER_DEFAULT", "DISCOVERED"],
    ["DISCOVERED", "FALLBACK"],
  ] as const)("resolves %s ahead of %s", (winner, loser) => {
    const catalog = createModelCatalogBuilder()
      // The loser is registered first and with the better priority, so only the
      // frozen precedence can explain the outcome.
      .registerSource(source(loser, 0, loser, 222))
      .registerSource(source(winner, 999, winner, 111))
      .build();

    expect(catalog.resolve(REF).source).toBe(winner);
    expect(catalog.resolve(REF).limits.contextWindowTokens).toBe(111);
  });

  it("uses priority as the deterministic tie-break inside one source kind", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(source("slow", 10, "CONFIGURATION", 222))
      .registerSource(source("fast", 0, "CONFIGURATION", 111))
      .build();

    expect(catalog.resolve(REF).limits.contextWindowTokens).toBe(111);
  });

  it("uses registration order when priority also ties", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(source("first", 0, "CONFIGURATION", 111))
      .registerSource(source("second", 0, "CONFIGURATION", 222))
      .build();

    expect(catalog.resolve(REF).limits.contextWindowTokens).toBe(111);
  });

  it("resolves every level on its own", () => {
    for (const level of [
      "CONFIGURATION",
      "BUILTIN",
      "PROVIDER_DEFAULT",
      "DISCOVERED",
      "FALLBACK",
    ] as const) {
      const catalog = createModelCatalogBuilder()
        .registerSource(source("only", 0, level, 123))
        .build();

      expect(catalog.resolve(REF).source).toBe(level);
      expect(catalog.has(REF)).toBe(true);
    }
  });
});

describe("ModelCatalog unknown model rule", () => {
  it("reports AI_MODEL_METADATA_INCOMPLETE when no source can describe the model", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(source("known", 0, "CONFIGURATION"))
      .build();

    expect(catalog.has({ provider: "openai", model: "unknown" })).toBe(false);
    expect(() => catalog.resolve({ provider: "openai", model: "unknown" })).toThrow(AIError);
    try {
      catalog.resolve({ provider: "openai", model: "unknown" });
      expect.unreachable("resolve must throw for an unknown model");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_MODEL_METADATA_INCOMPLETE");
      expect((error as AIError).retryable).toBe(false);
    }
  });

  it("never invents a descriptor for an unknown model", () => {
    // No fallback source exists, so an unknown model must stay unknown even for a
    // provider that allows unknown models. The provider gate lives in the gateway.
    const catalog = createModelCatalogBuilder()
      .registerSource(source("configured", 0, "CONFIGURATION"))
      .build();

    expect(catalog.has({ provider: "azure", model: "gpt-5" })).toBe(false);
  });

  it("describes an unknown model only through an explicit fallback source", () => {
    const fallback: ModelDescriptorSourcePort = {
      id: "safe-defaults",
      priority: 100,
      resolve: (requested) => ({
        ...descriptor("FALLBACK", 8_192, requested),
        api: "openai-compatible-chat",
      }),
    };

    const catalog = createModelCatalogBuilder()
      .registerSource(source("configured", 0, "CONFIGURATION"))
      .registerSource(fallback)
      .build();

    expect(catalog.resolve({ provider: "azure", model: "whatever" }).source).toBe("FALLBACK");
    expect(catalog.resolve({ provider: "azure", model: "whatever" }).limits).toEqual({
      contextWindowTokens: 8_192,
      maxOutputTokens: 1_000,
    });
    // A known model still prefers its explicit descriptor.
    expect(catalog.resolve(REF).source).toBe("CONFIGURATION");
  });
});

describe("ModelCatalog determinism and immutability", () => {
  it("resolves deterministically on repeated calls", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(source("a", 1, "BUILTIN", 111))
      .registerSource(source("b", 0, "DISCOVERED", 222))
      .build();

    const first = catalog.resolve(REF);
    const second = catalog.resolve(REF);

    expect(first.source).toBe(second.source);
    expect(first.limits).toEqual(second.limits);
  });
  it("lists a stable, sorted, deduplicated descriptor set", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(
        enumerableSource("builtin", 0, "BUILTIN", [
          { provider: "openai", model: "b" },
          { provider: "azure", model: "a" },
        ]),
      )
      .registerSource(
        enumerableSource("config", 5, "CONFIGURATION", [{ provider: "openai", model: "a" }]),
      )
      .build();

    const ids = catalog.list().map((entry) => `${entry.ref.provider}/${entry.ref.model}`);

    expect(ids).toEqual(["azure/a", "openai/a", "openai/b"]);
    expect(catalog.list()).toEqual(catalog.list());
    expect(Object.isFrozen(catalog.list())).toBe(true);
  });

  it("prefers the stronger source when two enumerable sources describe one model", () => {
    const catalog = createModelCatalogBuilder()
      .registerSource(enumerableSource("builtin", 0, "BUILTIN", [REF]))
      .registerSource(enumerableSource("config", 9, "CONFIGURATION", [REF]))
      .build();

    expect(catalog.list()).toHaveLength(1);
    expect(catalog.list()[0]?.source).toBe("CONFIGURATION");
  });

  it("is immutable after build", () => {
    const builder = createModelCatalogBuilder().registerSource(source("a", 0, "BUILTIN"));
    const catalog = builder.build();

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(() => builder.registerSource(source("b", 0, "BUILTIN"))).toThrow(TypeError);

    // A second build of the same builder is a defect, not a silent second catalog.
    expect(() => builder.build()).toThrow(TypeError);
  });
});

describe("ModelCatalogBuilder validation", () => {
  it("rejects a duplicate source id", () => {
    expect(() =>
      createModelCatalogBuilder()
        .registerSource(source("dup", 0, "BUILTIN"))
        .registerSource(source("dup", 1, "CONFIGURATION")),
    ).toThrow(TypeError);
  });

  it("rejects malformed sources and descriptors", () => {
    expect(() =>
      createModelCatalogBuilder().registerSource({
        id: "",
        priority: 0,
        resolve: () => undefined,
      }),
    ).toThrow(TypeError);

    expect(() =>
      createModelCatalogBuilder().registerSource({
        id: "bad-priority",
        priority: 1.5,
        resolve: () => undefined,
      }),
    ).toThrow(TypeError);

    expect(() =>
      createModelCatalogBuilder()
        .registerSource(enumerableSource("bad", 0, "BUILTIN", [{ provider: "openai", model: "x" }]))
        .registerSource({
          id: "liar",
          priority: 0,
          resolve: () => descriptor("BUILTIN", 1, { provider: "other", model: "y" }),
        })
        .build()
        .resolve(REF),
    ).toThrow(TypeError);

    // An enumerable source whose listed descriptor violates the model invariants is
    // a defective source, and `build()` must reject it rather than serve it.
    const brokenEnumerable: EnumerableModelDescriptorSourcePort = {
      id: "enumerable-broken",
      priority: 0,
      resolve: () => undefined,
      list: () => [
        { ...descriptor("BUILTIN"), limits: { contextWindowTokens: 1, maxOutputTokens: 5 } },
      ],
    };

    expect(() =>
      createModelCatalogBuilder()
        .registerSource(enumerableSource("broken", 0, "BUILTIN", [REF]))
        .registerSource(brokenEnumerable)
        .build(),
    ).toThrow(TypeError);
  });
});
