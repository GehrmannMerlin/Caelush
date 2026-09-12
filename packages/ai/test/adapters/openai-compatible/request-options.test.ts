import { describe, expect, it } from "vitest";
import { AIError } from "../../../src/errors/ai-error.js";
import {
  resolveOpenAICompatibleNativeOptions,
  toOpenAICompatibleProviderOptions,
} from "../../../src/adapters/openai-compatible/request-options.js";
import { modelDescriptor } from "../../support/fixtures.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";
import type { ResolvedAIModelRequest } from "../../../src/request/resolved-model-request.js";
import type { ReasoningLevel } from "../../../src/reasoning/reasoning-level.js";
import type { CacheRetention } from "../../../src/cache/cache-retention.js";

function model(
  supportedLevels?: readonly ReasoningLevel[],
  extra: {
    readonly cacheRetentions?: readonly CacheRetention[];
    readonly adapterMetadata?: ModelDescriptor["adapterMetadata"];
  } = {},
): ModelDescriptor {
  return modelDescriptor({
    ...(supportedLevels === undefined
      ? {}
      : { reasoning: { supportedLevels, supportsSummary: "UNKNOWN" } }),
    ...(extra.cacheRetentions === undefined
      ? {}
      : { cache: { supportedRetentions: extra.cacheRetentions } }),
    ...(extra.adapterMetadata === undefined ? {} : { adapterMetadata: extra.adapterMetadata }),
  });
}

function request(input: {
  readonly effectiveReasoning?: ReasoningLevel;
  readonly effectiveCache?: CacheRetention;
}): ResolvedAIModelRequest {
  return {
    model: model(),
    messages: [{ role: "user", content: "hello" }],
    settings: {
      reasoning:
        input.effectiveReasoning === undefined
          ? { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" }
          : {
              requested: input.effectiveReasoning,
              effective: input.effectiveReasoning,
              mode: "EXACT",
              policy: "PREFER_BUDGET",
            },
      cache: {
        requested: input.effectiveCache ?? "NONE",
        effective: input.effectiveCache ?? "NONE",
        mode: "EXACT",
      },
    },
  };
}

describe("OpenAI-compatible native reasoning translation", () => {
  it("adds no reasoning option when nothing was requested", () => {
    expect(resolveOpenAICompatibleNativeOptions(model(["LOW"]), request({}))).toEqual({});
  });

  it("omits the native option for OFF", () => {
    // OFF means "do not steer reasoning"; inventing a native "none" value would be
    // a claim this dialect does not make.
    expect(
      resolveOpenAICompatibleNativeOptions(model(["OFF"]), request({ effectiveReasoning: "OFF" })),
    ).toEqual({});
  });

  it("maps the four standard levels onto the native effort string", () => {
    const cases = [
      ["MINIMAL", "minimal"],
      ["LOW", "low"],
      ["MEDIUM", "medium"],
      ["HIGH", "high"],
    ] as const;

    for (const [level, effort] of cases) {
      expect(
        resolveOpenAICompatibleNativeOptions(
          model([level]),
          request({ effectiveReasoning: level }),
        ),
        level,
      ).toEqual({ reasoningEffort: effort });
    }
  });

  it("fails closed for a level the dialect has no standard value for", () => {
    try {
      resolveOpenAICompatibleNativeOptions(
        model(["XHIGH"]),
        request({ effectiveReasoning: "XHIGH" }),
      );
      expect.unreachable("XHIGH must not be silently dropped");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
      expect((error as AIError).retryable).toBe(false);
    }
  });

  it("honours an explicit model-level effort override", () => {
    const descriptor = model(["XHIGH"], {
      adapterMetadata: {
        "openai-compatible": { reasoningEffortByLevel: { XHIGH: "xhigh" } },
      },
    });

    expect(
      resolveOpenAICompatibleNativeOptions(descriptor, request({ effectiveReasoning: "XHIGH" })),
    ).toEqual({ reasoningEffort: "xhigh" });
  });

  it("ignores an unusable override value and still fails closed", () => {
    const descriptor = model(["XHIGH"], {
      adapterMetadata: { "openai-compatible": { reasoningEffortByLevel: { XHIGH: "" } } },
    });

    expect(() =>
      resolveOpenAICompatibleNativeOptions(descriptor, request({ effectiveReasoning: "XHIGH" })),
    ).toThrow(AIError);
  });

  it("never branches on a provider name", () => {
    // The same descriptor and request must behave identically for any provider id.
    const descriptor = model(["HIGH"]);
    const withUnknownProvider: ModelDescriptor = {
      ...descriptor,
      ref: { provider: "deepseek", model: "whatever" },
    };
    const withAnother: ModelDescriptor = {
      ...descriptor,
      ref: { provider: "openrouter", model: "whatever" },
    };

    expect(
      resolveOpenAICompatibleNativeOptions(
        withUnknownProvider,
        request({ effectiveReasoning: "HIGH" }),
      ),
    ).toEqual(
      resolveOpenAICompatibleNativeOptions(withAnother, request({ effectiveReasoning: "HIGH" })),
    );
  });
});

describe("OpenAI-compatible native cache translation", () => {
  it("adds nothing when the effective retention is NONE", () => {
    expect(
      resolveOpenAICompatibleNativeOptions(model(), request({ effectiveCache: "NONE" })),
    ).toEqual({});
  });

  it("fails closed when a retention cannot be expressed by this dialect", () => {
    // The pinned SDK exposes no prompt-cache control, so claiming to have applied
    // SHORT or LONG would be dishonest.
    for (const retention of ["SHORT", "LONG"] as CacheRetention[]) {
      try {
        resolveOpenAICompatibleNativeOptions(model(), request({ effectiveCache: retention }));
        expect.unreachable(`${retention} must not be silently dropped`);
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
      }
    }
  });
});

describe("OpenAI-compatible provider options envelope", () => {
  it("returns undefined when there is nothing to send", () => {
    expect(toOpenAICompatibleProviderOptions("compat-fixture", {})).toBeUndefined();
  });

  it("keys the native options by the configured provider name in its preferred form", () => {
    // The pinned SDK reads both spellings but deprecates the raw one, so the
    // adapter emits the camelCase key the SDK prefers.
    expect(
      toOpenAICompatibleProviderOptions("compat-fixture", { reasoningEffort: "high" }),
    ).toEqual({
      compatFixture: { reasoningEffort: "high" },
    });
    // Only a separator before a lowercase letter is folded, exactly like the SDK.
    expect(toOpenAICompatibleProviderOptions("other_1", { reasoningEffort: "low" })).toEqual({
      other_1: { reasoningEffort: "low" },
    });
    expect(toOpenAICompatibleProviderOptions("open_ai", { reasoningEffort: "low" })).toEqual({
      openAi: { reasoningEffort: "low" },
    });
    expect(toOpenAICompatibleProviderOptions("openai", { reasoningEffort: "low" })).toEqual({
      openai: { reasoningEffort: "low" },
    });
  });
});
