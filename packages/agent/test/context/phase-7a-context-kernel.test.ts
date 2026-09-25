import { describe, expect, it } from "vitest";

import type { AIToolSpec, JsonObject, ModelDescriptor } from "@caelush/ai";
import {
  assertContextItem,
  assertContextFingerprint,
  collectContextSources,
  ContextSourceCollectionError,
  createContextFingerprint,
  createContextItem,
  createContextItemId,
  createContextPolicy,
  createContextSourceId,
  createContextSourceRegistryBuilder,
  createUtf8HeuristicTokenEstimator,
  classifyContextPressure,
  type ContextItem,
  type ContextSourceInput,
} from "@caelush/agent";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7a" },
  api: "test-api",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const SOURCE_INPUT = { signal: new AbortController().signal } as ContextSourceInput;

const TEXT_ITEM: ContextItem = {
  id: createContextItemId("agent.goal.current"),
  type: "agent.goal",
  source: {
    providerId: createContextSourceId("agent.extension-contributions"),
    sourceRef: "goal",
    version: "1",
  },
  scope: "TURN",
  retention: "PINNED",
  priorityClass: "CRITICAL",
  tokenEstimate: 3,
  cacheStability: "DYNAMIC",
  freshness: "CURRENT",
  sensitivity: "PUBLIC",
  whyLoaded: "current goal",
  payload: { kind: "TEXT", text: "Ship the context kernel." },
};

function tool(name: string, inputSchema: JsonObject = {}): AIToolSpec {
  return { name, description: `${name} description`, inputSchema };
}

describe("Phase 7A ContextItem contract", () => {
  it("accepts a valid item and returns an immutable value", () => {
    const item = createContextItem(TEXT_ITEM);

    expect(item).toEqual(TEXT_ITEM);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.source)).toBe(true);
    expect(Object.isFrozen(item.payload)).toBe(true);
  });

  it("rejects malformed identity, provenance, budget, and payload at runtime", () => {
    expect(() => createContextItem({ ...TEXT_ITEM, id: "" } as never)).toThrow();
    expect(() =>
      createContextItem({ ...TEXT_ITEM, source: { ...TEXT_ITEM.source, version: "" } }),
    ).toThrow();
    expect(() => createContextItem({ ...TEXT_ITEM, tokenEstimate: -1 })).toThrow();
    expect(() =>
      createContextItem({ ...TEXT_ITEM, tokenEstimate: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => createContextItem({ ...TEXT_ITEM, atomicGroupId: "" })).toThrow();
    expect(() =>
      createContextItem({ ...TEXT_ITEM, payload: { kind: "TEXT", text: 42 } as never }),
    ).toThrow();
    expect(() => assertContextItem({ ...TEXT_ITEM, sensitivity: "SECRET" })).toThrow();
  });
});

describe("Phase 7A semantic context foundation", () => {
  it("brands non-empty fingerprints without materializing provider messages", () => {
    const fingerprint = createContextFingerprint("sha256:context");

    expect(fingerprint).toBe("sha256:context");
    expect(() => assertContextFingerprint(fingerprint)).not.toThrow();
    expect(() => createContextFingerprint(" ")).toThrow();
  });
});

describe("Phase 7A ModelDescriptor-derived policy", () => {
  it("uses model limits as intrinsic authority and subtracts reserves and request overhead", () => {
    const policy = createContextPolicy({
      model: MODEL,
      requestOverhead: { toolSchemaTokens: 300, protocolOverheadTokens: 25, totalTokens: 325 },
      options: { outputReserveTokens: 1_000, safetyReserveTokens: 200 },
    });

    expect(policy.contextWindowTokens).toBe(10_000);
    expect(policy.maxOutputTokens).toBe(2_000);
    expect(policy.effectiveInputLimitTokens).toBe(8_475);
    expect(policy.proactiveCompactionTokens).toBe(6_356);
    expect(policy.emergencyCompactionTokens).toBe(7_627);
    expect(policy.observationPolicy.maxSingleObservationTokens).toBe(847);
    expect(policy.observationPolicy.maxObservationBatchTokens).toBe(1_864);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.requestOverhead)).toBe(true);
    expect(classifyContextPressure(policy.proactiveCompactionTokens - 1, policy)).toBe("NORMAL");
    expect(classifyContextPressure(policy.proactiveCompactionTokens, policy)).toBe("PROACTIVE");
    expect(classifyContextPressure(policy.emergencyCompactionTokens, policy)).toBe("EMERGENCY");
  });

  it("rejects reserves that leave no positive effective input budget", () => {
    expect(() =>
      createContextPolicy({
        model: MODEL,
        requestOverhead: { toolSchemaTokens: 8_000, protocolOverheadTokens: 0, totalTokens: 8_000 },
        options: { outputReserveTokens: 2_000, safetyReserveTokens: 1 },
      }),
    ).toThrow();
  });
});

describe("Phase 7A token and request overhead ports", () => {
  it("counts text deterministically without provider-specific tokenizers", () => {
    const estimator = createUtf8HeuristicTokenEstimator();

    expect(estimator.estimateText("abc", MODEL)).toBe(1);
    expect(estimator.estimateText("你好", MODEL)).toBe(2);
    expect(estimator.estimateText("😀", MODEL)).toBe(2);
    expect(estimator.estimateText("abc", MODEL)).toBe(estimator.estimateText("abc", MODEL));
  });

  it("counts tool schema overhead and preserves input order deterministically", () => {
    const estimator = createContextPolicy({
      model: MODEL,
      tools: [tool("read"), tool("write")],
    }).requestOverhead;
    const larger = createContextPolicy({
      model: MODEL,
      tools: [tool("read", { type: "object", properties: { path: { type: "string" } } })],
    }).requestOverhead;

    expect(estimator.toolSchemaTokens).toBeGreaterThan(0);
    expect(estimator.totalTokens).toBe(
      estimator.toolSchemaTokens + estimator.protocolOverheadTokens,
    );
    expect(larger.toolSchemaTokens).toBeGreaterThan(0);
    expect(larger.totalTokens).toBe(larger.toolSchemaTokens + larger.protocolOverheadTokens);
  });
});

describe("Phase 7A immutable source registry", () => {
  it("orders registrations by priority then source id and rejects duplicates", () => {
    const provider = (rawId: string) => {
      const id = createContextSourceId(rawId);
      return {
        id,
        collect: async () => ({ providerId: id, providerVersion: "1", items: [], diagnostics: [] }),
      };
    };
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("z"),
        priority: 10,
        criticality: "OPTIONAL",
        provider: provider("z"),
      })
      .register({
        id: createContextSourceId("a"),
        priority: 10,
        criticality: "REQUIRED",
        provider: provider("a"),
      })
      .register({
        id: createContextSourceId("m"),
        priority: 1,
        criticality: "REQUIRED",
        provider: provider("m"),
      })
      .build();

    expect(registry.list().map((entry) => entry.id)).toEqual(["m", "a", "z"]);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(() =>
      createContextSourceRegistryBuilder()
        .register({
          id: createContextSourceId("same"),
          priority: 1,
          criticality: "REQUIRED",
          provider: provider("same"),
        })
        .register({
          id: createContextSourceId("same"),
          priority: 2,
          criticality: "OPTIONAL",
          provider: provider("same"),
        }),
    ).toThrow();
  });

  it("fails required sources, skips optional failures, and propagates aborts", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("optional"),
        priority: 1,
        criticality: "OPTIONAL",
        provider: {
          id: createContextSourceId("optional"),
          collect: async () => {
            throw new Error("optional failure");
          },
        },
      })
      .register({
        id: createContextSourceId("required"),
        priority: 2,
        criticality: "REQUIRED",
        provider: {
          id: createContextSourceId("required"),
          collect: async () => ({
            providerId: createContextSourceId("required"),
            providerVersion: "v1",
            items: [],
            diagnostics: [],
          }),
        },
      })
      .build();

    const results = await collectContextSources(registry, SOURCE_INPUT);
    expect(results).toHaveLength(2);
    expect(results[0]?.providerId).toBe("optional");
    expect(results[0]?.diagnostics[0]?.severity).toBe("WARNING");
    expect(results[1]?.providerVersion).toBe("v1");

    const requiredFailure = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("required"),
        priority: 1,
        criticality: "REQUIRED",
        provider: {
          id: createContextSourceId("required"),
          collect: async () => {
            throw new Error("required failure");
          },
        },
      })
      .build();
    await expect(collectContextSources(requiredFailure, SOURCE_INPUT)).rejects.toBeInstanceOf(
      ContextSourceCollectionError,
    );

    const abortRegistry = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("optional"),
        priority: 1,
        criticality: "OPTIONAL",
        provider: {
          id: createContextSourceId("optional"),
          collect: async () => {
            throw abort;
          },
        },
      })
      .build();
    await expect(collectContextSources(abortRegistry, SOURCE_INPUT)).rejects.toBe(abort);

    const controller = new AbortController();
    const abortedRegistry = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("aborted"),
        priority: 1,
        criticality: "OPTIONAL",
        provider: {
          id: createContextSourceId("aborted"),
          collect: async () => {
            throw new Error("provider stopped after cancellation");
          },
        },
      })
      .build();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(
      collectContextSources(abortedRegistry, { signal: controller.signal } as ContextSourceInput),
    ).rejects.toBe(reason);
  });
});
