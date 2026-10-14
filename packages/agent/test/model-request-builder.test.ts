import type { AIModelSettings, ModelDescriptor } from "@caelush/ai";
import type { PreparedModelContext } from "@caelush/agent";
import { describe, expect, it } from "vitest";
import * as contextPolicy from "../src/context/policy/context-policy.js";
import { buildModelRequest } from "../src/loop/turn/model-request-builder.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "million-context" },
  api: "fixture-api",
  limits: { contextWindowTokens: 1_048_576, maxOutputTokens: 393_216 },
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

type AdaptiveBudget = (input: {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly configuredOutputCeiling?: number;
  readonly requestOverheadTokens: number;
}) => {
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly preferredOutputCeiling: number;
  readonly effectiveInputLimitTokens: number;
};

const resolveAdaptiveContextBudget = (contextPolicy as unknown as Record<string, unknown>)
  .resolveAdaptiveContextBudget as AdaptiveBudget | undefined;

function prepared(
  estimatedInputTokens: number,
  version: "ADAPTIVE_V1" | "LEGACY_FULL_OUTPUT_V1" = "ADAPTIVE_V1",
  outputReserveTokens = 16_384,
  safetyReserveTokens = 4_096,
): PreparedModelContext {
  const effectiveInputLimitTokens =
    MODEL.limits.contextWindowTokens - outputReserveTokens - safetyReserveTokens - 1_516;
  return {
    messages: [{ role: "user", content: "continue the task" }],
    report: {
      estimatedInputTokens,
      effectiveInputLimitTokens,
      remainingTokens: Math.max(0, effectiveInputLimitTokens - estimatedInputTokens),
      pressure: "NORMAL",
      compactionCount: 0,
      requestOverheadTokens: 1_516,
      contributions: [],
    },
    observationPolicy: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 1 },
    requestBudget: { version, outputReserveTokens, safetyReserveTokens },
  };
}

describe("adaptive context budget resolver", () => {
  it("reserves 16k output and 4k safety for the million-token model", () => {
    expect(resolveAdaptiveContextBudget).toBeTypeOf("function");
    if (resolveAdaptiveContextBudget === undefined) return;
    expect(
      resolveAdaptiveContextBudget({
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 393_216,
        requestOverheadTokens: 1_516,
      }),
    ).toEqual({
      outputReserveTokens: 16_384,
      safetyReserveTokens: 4_096,
      preferredOutputCeiling: 393_216,
      effectiveInputLimitTokens: 1_026_580,
    });
  });

  it("uses the configured ceiling and scales reserves for a small valid model window", () => {
    expect(resolveAdaptiveContextBudget).toBeTypeOf("function");
    if (resolveAdaptiveContextBudget === undefined) return;
    expect(
      resolveAdaptiveContextBudget({
        contextWindowTokens: 64,
        maxOutputTokens: 24,
        configuredOutputCeiling: 16,
        requestOverheadTokens: 0,
      }),
    ).toEqual({
      outputReserveTokens: 5,
      safetyReserveTokens: 1,
      preferredOutputCeiling: 16,
      effectiveInputLimitTokens: 58,
    });
  });

  it("rejects an overhead estimate that consumes the entire input budget", () => {
    expect(resolveAdaptiveContextBudget).toBeTypeOf("function");
    if (resolveAdaptiveContextBudget === undefined) return;
    expect(() =>
      resolveAdaptiveContextBudget({
        contextWindowTokens: 64,
        maxOutputTokens: 24,
        requestOverheadTokens: 58,
      }),
    ).toThrow(RangeError);
  });
});

describe("adaptive model request output ceiling", () => {
  it("leaves the provider default absent when input leaves full output headroom", () => {
    const request = buildModelRequest({ context: prepared(42_720), model: MODEL, tools: [] });

    expect(request.settings).toBeUndefined();
  });

  it("preserves an explicit sufficient ceiling and all other static settings", () => {
    const settings: AIModelSettings = { maxOutputTokens: 8_192, temperature: 0.2 };
    const request = buildModelRequest({
      context: prepared(42_720, "ADAPTIVE_V1", 8_192),
      model: MODEL,
      tools: [],
      settings,
    });

    expect(request.settings).toBe(settings);
  });

  it("clamps the actual request to the remaining window for a large prepared input", () => {
    const request = buildModelRequest({ context: prepared(970_000), model: MODEL, tools: [] });

    expect(request.settings).toEqual({ maxOutputTokens: 72_964 });
  });

  it("preserves static settings while adding only the required output cap", () => {
    const settings: AIModelSettings = { temperature: 0.2 };
    const request = buildModelRequest({
      context: prepared(970_000),
      model: MODEL,
      tools: [],
      settings,
    });

    expect(request.settings).toEqual({ ...settings, maxOutputTokens: 72_964 });
    expect(settings).toEqual({ temperature: 0.2 });
  });

  it.each([1_042_964, 1_042_965])(
    "fails closed when input and overhead leave no positive output headroom (%i tokens)",
    (estimatedInputTokens) => {
      expect(() =>
        buildModelRequest({
          context: prepared(estimatedInputTokens),
          model: MODEL,
          tools: [],
        }),
      ).toThrow(RangeError);
    },
  );

  it("keeps historical full-output request defaults without applying the adaptive clamp", () => {
    const request = buildModelRequest({
      context: prepared(970_000, "LEGACY_FULL_OUTPUT_V1"),
      model: MODEL,
      tools: [],
    });

    expect(request.settings).toBeUndefined();
  });

  it("rejects an invalid adaptive reserve snapshot before building a request", () => {
    const context = prepared(42_720, "ADAPTIVE_V1", 0, 4_096);

    expect(() => buildModelRequest({ context, model: MODEL, tools: [] })).toThrow(RangeError);
  });
});
