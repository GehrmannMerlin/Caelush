import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { evaluatePromptCacheAudit } from "./prompt-cache-audit.mjs";

function sample(
  callId: string,
  input: {
    readonly purpose?: string;
    readonly inputTokens?: number;
    readonly hitTokens?: number;
    readonly missTokens?: number;
    readonly writeTokens?: number;
    readonly expectedReusablePrefixTokens?: number;
    readonly eligible?: boolean;
    readonly success?: boolean;
    readonly resetReason?: string;
  } = {},
) {
  return {
    callId,
    purpose: input.purpose ?? "MAIN_AGENT",
    inputTokens: input.inputTokens ?? 100_000,
    hitTokens: input.hitTokens ?? 97_000,
    missTokens: input.missTokens ?? 3_000,
    writeTokens: input.writeTokens ?? 0,
    epochId: "epoch-a",
    resetReason: input.resetReason,
    expectedReusablePrefixTokens: input.expectedReusablePrefixTokens ?? 97_000,
    eligible: input.eligible ?? true,
    success: input.success ?? true,
  };
}

function options(
  input: {
    readonly expectedScoredCount?: number;
    readonly observedProviderCallCount?: number;
  } = {},
) {
  return {
    expectedScoredCount: input.expectedScoredCount ?? 1,
    observedProviderCallCount: input.observedProviderCallCount ?? 1,
  };
}

describe("offline prompt-cache audit", () => {
  it.each([
    { label: "96.999%", hitTokens: 96_999, missTokens: 3_001, passed: false },
    { label: "97.000%", hitTokens: 97_000, missTokens: 3_000, passed: true },
  ])("applies the unrounded $label billing threshold", ({ hitTokens, missTokens, passed }) => {
    const result = evaluatePromptCacheAudit(
      [sample("call-1", { hitTokens, missTokens })],
      options(),
    );

    expect(result.billingHitRate).toBe(hitTokens / (hitTokens + missTokens));
    expect(result.passed).toBe(passed);
  });

  it("marks missing usage UNREPORTED and fails closed", () => {
    const incomplete = sample("call-1");
    delete (incomplete as Partial<typeof incomplete>).hitTokens;
    delete (incomplete as Partial<typeof incomplete>).missTokens;

    const result = evaluatePromptCacheAudit([incomplete], options());

    expect(result.sampleStatuses).toEqual([{ index: 0, status: "UNREPORTED" }]);
    expect(result.billingHitRate).toBe("UNREPORTED");
    expect(result.metricsV2.usageCoverage).toMatchObject({
      observedRequestCount: 1,
      completeCacheUsageCount: 0,
      status: "UNREPORTED",
    });
    expect(result.unknownUsageCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("withholds scored rates when one otherwise-scored call has missing usage", () => {
    const incomplete = sample("call-2");
    delete (incomplete as Partial<typeof incomplete>).hitTokens;

    const result = evaluatePromptCacheAudit(
      [sample("call-1"), incomplete],
      options({ expectedScoredCount: 2, observedProviderCallCount: 2 }),
    );

    expect(result.sampleStatuses).toEqual([
      { index: 0, status: "SCORED" },
      { index: 1, status: "UNREPORTED" },
    ]);
    expect(result.unknownUsageCount).toBe(1);
    expect(result.billingHitRate).toBe("UNREPORTED");
    expect(result.metricsV2.usageCoverage.incompleteOrUnknownCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("does not count duplicate call identities as distinct provider requests", () => {
    const result = evaluatePromptCacheAudit(
      [sample("same-call"), sample("same-call")],
      options({ expectedScoredCount: 2, observedProviderCallCount: 2 }),
    );

    expect(result.sampleStatuses).toEqual([
      { index: 0, status: "SCORED" },
      { index: 1, status: "DUPLICATE" },
    ]);
    expect(result.scoredCount).toBe(1);
    expect(result.duplicateCallIdCount).toBe(1);
    expect(result.billingHitRate).toBe("UNREPORTED");
    expect(result.metricsV2.usageCoverage.observedRequestCount).toBe(1);
    expect(result.totalInputTokens).toBe("UNREPORTED");
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("same-call");
  });

  it("fails closed when a sample has no call identity", () => {
    const unidentified = { ...sample("call-1"), callId: "" };

    const result = evaluatePromptCacheAudit([unidentified], options());

    expect(result.missingCallIdCount).toBe(1);
    expect(result.scoredCount).toBe(0);
    expect(result.billingHitRate).toBe("UNREPORTED");
    expect(result.passed).toBe(false);
  });

  it("fails when the provider observed more requests than the audit inventory", () => {
    const result = evaluatePromptCacheAudit(
      [sample("call-1")],
      options({ observedProviderCallCount: 2 }),
    );

    expect(result.hiddenCallCount).toBe(1);
    expect(result.totalCallCount).toBe(2);
    expect(result.totalInputTokens).toBe("UNREPORTED");
    expect(result.passed).toBe(false);
  });

  it("keeps auxiliary and reset requests in totals but excludes them from scored turns", () => {
    const samples = [
      sample("main-1"),
      sample("warmup", { purpose: "WARMUP", inputTokens: 50, hitTokens: 0, missTokens: 50 }),
      sample("retry", { purpose: "RETRY", inputTokens: 40, hitTokens: 0, missTokens: 40 }),
      sample("compaction", {
        purpose: "COMPACTION",
        inputTokens: 30,
        hitTokens: 0,
        missTokens: 30,
      }),
      sample("title", { purpose: "TITLE", inputTokens: 20, hitTokens: 0, missTokens: 20 }),
      sample("other", { purpose: "OTHER", inputTokens: 10, hitTokens: 0, missTokens: 10 }),
      sample("reset", { resetReason: "model-change", inputTokens: 5, hitTokens: 0, missTokens: 5 }),
      sample("ineligible", { eligible: false }),
      sample("failed", { success: false }),
    ];

    const result = evaluatePromptCacheAudit(
      samples,
      options({ expectedScoredCount: 1, observedProviderCallCount: samples.length }),
    );

    expect(result.scoredCount).toBe(1);
    expect(result.totalCallCount).toBe(9);
    expect(result.totalInputTokens).toBe(300_155);
    expect(result.sampleStatuses.slice(1).every((entry) => entry.status === "EXCLUDED")).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("uses token totals rather than averaging per-request percentages", () => {
    const result = evaluatePromptCacheAudit(
      [
        sample("large", {
          inputTokens: 100,
          hitTokens: 99,
          missTokens: 1,
          expectedReusablePrefixTokens: 100,
        }),
        sample("small", {
          inputTokens: 1,
          hitTokens: 0,
          missTokens: 1,
          expectedReusablePrefixTokens: 0,
        }),
      ],
      options({ expectedScoredCount: 2, observedProviderCallCount: 2 }),
    );

    expect(result.billingHitRate).toBe(99 / 101);
    expect(result.metricsV2.fullRun.mainAgent.hitRate).toBe(99 / 101);
    expect(result.metricsV2.previousInputCoverageProxy).toBe("UNREPORTED");
    expect("reusablePrefixEfficiency" in result).toBe(false);
    expect(result.passed).toBe(true);
  });

  it("returns UNREPORTED when either rate denominator is empty", () => {
    const result = evaluatePromptCacheAudit(
      [
        sample("empty", {
          inputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          expectedReusablePrefixTokens: 0,
        }),
      ],
      options(),
    );

    expect(result.billingHitRate).toBe("UNREPORTED");
    expect(result.metricsV2.fullRun.mainAgent.hitRate).toBeUndefined();
    expect(result.passed).toBe(false);
  });

  it("does not expose sample content or identifiers in its summary", () => {
    const result = evaluatePromptCacheAudit(
      [
        {
          ...sample("opaque-call"),
          prompt: "DO_NOT_EMIT_PROMPT",
          toolArguments: "DO_NOT_EMIT_ARGUMENTS",
          hostPath: "DO_NOT_EMIT_PATH",
          credential: "DO_NOT_EMIT_CREDENTIAL",
        },
      ],
      options(),
    );
    const output = JSON.stringify(result);

    expect(output).not.toContain("opaque-call");
    expect(output).not.toContain("DO_NOT_EMIT");
  });

  it("reports the original eight-request sample with token-weighted Full and Warm rates", () => {
    const inputs = [15_153, 31_192, 37_252, 45_670, 57_639, 64_418, 69_321, 74_248];
    const hits = [512, 15_104, 31_104, 37_248, 45_568, 57_600, 64_384, 69_248];
    const samples = inputs.map((inputTokens, index) =>
      sample(`call-${index + 1}`, {
        inputTokens,
        hitTokens: hits[index],
        missTokens: inputTokens - hits[index],
      }),
    );
    const result = evaluatePromptCacheAudit(
      samples,
      options({ expectedScoredCount: 8, observedProviderCallCount: 8 }),
    );

    expect(result.metricsV2.fullRun.mainAgent.hitRate).toBeCloseTo(0.8123, 4);
    expect(result.metricsV2.warm.mainAgent.hitRate).toBeCloseTo(0.8434, 4);
    expect(result.metricsV2.warm.mainAgent.requestCount).toBe(7);
  });

  it("never turns the legacy expected-prefix formula into a cache health metric", () => {
    const legacySample = sample("legacy-prefix", {
      hitTokens: 69_248,
      expectedReusablePrefixTokens: 39_306,
    });
    const result = evaluatePromptCacheAudit([legacySample], options());

    expect(Math.min(69_248, 39_306) / 39_306).toBe(1);
    expect(result.metricsV2.previousInputCoverageProxy).toBe("UNREPORTED");
    expect("reusablePrefixEfficiency" in result).toBe(false);
  });

  it("keeps provider-reported hit/miss coverage separate from incomplete Usage", () => {
    const partial = sample("partial", { inputTokens: 123 });
    delete (partial as Partial<typeof partial>).hitTokens;
    delete (partial as Partial<typeof partial>).missTokens;
    const result = evaluatePromptCacheAudit([partial], options());

    expect(result.metricsV2.fullRun.mainAgent.hitRate).toBeUndefined();
    expect(result.metricsV2.usageCoverage).toMatchObject({
      observedRequestCount: 1,
      completeCacheUsageCount: 0,
      incompleteOrUnknownCount: 1,
    });
    expect(result.metricsV2.latestRequest).toMatchObject({ cacheUsageReported: false });
  });

  it("resets the Warm boundary for a new cache Epoch and bounds Rolling to ten calls", () => {
    const epochs = [
      sample("epoch-a-cold", { hitTokens: 0, missTokens: 100 }),
      sample("epoch-a-warm-1", { hitTokens: 90, missTokens: 10 }),
      sample("epoch-a-warm-2", { hitTokens: 90, missTokens: 10 }),
      {
        ...sample("epoch-b-reset", { hitTokens: 0, missTokens: 100 }),
        epochId: "epoch-b",
        resetReason: "provider-reset",
      },
      { ...sample("epoch-b-warm", { hitTokens: 80, missTokens: 20 }), epochId: "epoch-b" },
    ];
    const epochResult = evaluatePromptCacheAudit(
      epochs,
      options({ expectedScoredCount: 4, observedProviderCallCount: epochs.length }),
    );
    const rolling = Array.from({ length: 12 }, (_, index) =>
      sample(`rolling-${index}`, {
        hitTokens: index < 1 ? 99 : 0,
        missTokens: index < 1 ? 1 : 100,
      }),
    );
    const rollingResult = evaluatePromptCacheAudit(
      rolling,
      options({ expectedScoredCount: rolling.length, observedProviderCallCount: rolling.length }),
    );

    expect(epochResult.metricsV2.warm.mainAgent.requestCount).toBe(3);
    expect(rollingResult.metricsV2.rolling.mainAgent.requestCount).toBe(10);
    expect(rollingResult.metricsV2.rolling.mainAgent.hitRate).toBe(0);
  });

  it("runs the checked-in fixture through the offline CLI", () => {
    const run = spawnSync(process.execPath, ["scripts/prompt-cache-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as {
      readonly fixtureCheckPassed: boolean;
      readonly cases: readonly { readonly name: string; readonly passed: boolean }[];
    };
    expect(report.fixtureCheckPassed).toBe(true);
    expect(report.compatibilityMode).toBe("LEGACY_FIXTURE_INPUTS");
    expect(report.cases.map(({ name, passed }) => [name, passed])).toEqual([
      ["billing-96.999", false],
      ["billing-97.000", true],
      ["missing-usage", false],
      ["partial-missing-scored-usage", false],
      ["duplicate-call-identity", false],
      ["hidden-provider-call", false],
      ["auxiliary-only", false],
      ["weighted-tokens", true],
      ["empty-denominators", false],
    ]);
  });
});
