import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRunId } from "@caelush/protocol";
import type { ContextUsageProjection, PromptCacheUsage } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextUsageRing } from "../src/components/context-usage-ring.js";
import { ContextInspector } from "../src/components/context-inspector.js";

const baseUsage: ContextUsageProjection = {
  runId: createRunId(),
  providerId: "fixture",
  modelId: "small",
  contextWindowTokens: 1000,
  rawContextWindowTokens: 1200,
  effectiveInputLimitTokens: 800,
  estimatedInputTokens: 400,
  usedRatio: 0.5,
  remainingTokens: 400,
  pressureState: "NORMAL",
  compactionCount: 1,
  breakdown: {
    pinned: 0,
    checkpoint: 20,
    recentTail: 100,
    project: 50,
    files: 100,
    toolObservations: 80,
    memory: 50,
    systemTokens: 60,
    goalTokens: 12,
    currentUserTokens: 20,
    relevantFileTokens: 100,
    currentTurnTokens: 180,
    mandatoryTokens: 200,
  },
  lastBuildAt: 2,
  lastRecoveryStages: ["REBUILD_CONTEXT"],
  updatedAt: 1,
};

const basePromptCache: PromptCacheUsage = {
  status: "WARM",
  sampleCount: 1,
  totalRequestCount: 2,
  totalInputTokens: 560,
  totalOutputTokens: 25,
  hitTokens: 400,
  missTokens: 100,
  writeTokens: 20,
  unknownUsageCount: 1,
  latestHitRate: 0.8,
  rollingHitRate: 0.8,
  expectedReusablePrefixTokens: 500,
  reusablePrefixEfficiency: 0.8,
  epochId: "cycle-4",
  lastMeasuredAt: 3,
  purposes: [
    {
      purpose: "MAIN_AGENT",
      requestCount: 1,
      inputTokens: 500,
      outputTokens: 20,
      hitTokens: 400,
      missTokens: 100,
      writeTokens: 20,
      reasoningTokens: 0,
      usageFieldCoverage: {
        inputTokens: 1,
        outputTokens: 1,
        hitTokens: 1,
        missTokens: 1,
        writeTokens: 1,
        reasoningTokens: 0,
      },
      unknownUsageCount: 0,
    },
    {
      purpose: "COMPACTION",
      requestCount: 1,
      inputTokens: 60,
      outputTokens: 5,
      hitTokens: 0,
      missTokens: 0,
      writeTokens: 0,
      reasoningTokens: 0,
      usageFieldCoverage: {
        inputTokens: 1,
        outputTokens: 1,
        hitTokens: 0,
        missTokens: 0,
        writeTokens: 0,
        reasoningTokens: 0,
      },
      unknownUsageCount: 1,
    },
  ],
  metricsV2: {
    fullRun: {
      mainAgent: { requestCount: 2, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
      allPurposes: { requestCount: 2, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
    },
    warm: {
      mainAgent: { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
      allPurposes: { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
    },
    rolling: {
      windowSize: 10,
      mainAgent: { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
      allPurposes: { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
    },
    latestRequest: {
      purpose: "MAIN_AGENT",
      inputTokens: 500,
      hitTokens: 400,
      missTokens: 100,
      cacheUsageReported: true,
    },
    previousInputCoverage: {
      classification: "DIAGNOSTIC_PROXY",
      hitTokens: 400,
      previousInputTokens: 500,
      coverage: 0.8,
    },
    usageCoverage: {
      observedRequestCount: 2,
      completeCacheUsageCount: 1,
      incompleteOrUnknownCount: 1,
      providerUsageUnreportedCount: 0,
      providerUsageWithoutCacheBreakdownCount: 1,
      failedOrCancelledWithoutUsageCount: 0,
      inProgressInvocationCount: 0,
      missingInvocationRecordCount: 1,
      legacyWithoutCacheBreakdownCount: 1,
      unidentifiedLegacySampleCount: 0,
      coverageRate: 0.5,
      status: "PARTIAL",
    },
    surfaceDelta: {
      availability: "AVAILABLE",
      baselineCount: 1,
      deltaCount: 1,
      noopCount: 0,
      setCount: 2,
      clearCount: 0,
      newModelVisibleBytes: 900,
      estimatedNewContextTokens: 300,
      unchangedSectionReemissionCount: 0,
      tokenEstimateKind: "ESTIMATED",
    },
  },
};

describe("ContextUsageRing", () => {
  it("renders a restrained accessible SVG ring using used ratio", () => {
    const markup = renderToStaticMarkup(<ContextUsageRing usage={baseUsage} />);
    const inspectorMarkup = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    expect(markup).toContain('aria-label="工作上下文用量：50%"');
    expect(markup).toContain('viewBox="0 0 18 18"');
    expect(markup).toContain('stroke-dashoffset="0.5"');
    expect(markup).toContain("工作上下文");
    expect(inspectorMarkup).toContain("Raw Context Window");
    expect(inspectorMarkup).toContain("1,200 tokens");
    expect(inspectorMarkup).toContain("Current Turn");
    expect(inspectorMarkup).toContain("180 tokens");
  });

  it("clamps invalid ratios to the visible 0%–100% ring range", () => {
    const overfull = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, usedRatio: 1.4 }} />,
    );
    const negative = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, usedRatio: -0.2 }} />,
    );
    expect(overfull).toContain('stroke-dashoffset="0"');
    expect(negative).toContain('stroke-dashoffset="1"');
  });

  it("shows all cache states and keeps unreported rates textual", () => {
    const warm = renderToStaticMarkup(
      <ContextInspector usage={{ ...baseUsage, promptCache: basePromptCache }} />,
    );
    const cold = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: { ...basePromptCache, status: "COLD_START" },
        }}
      />,
    );
    const reset = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: {
            ...basePromptCache,
            status: "RESET",
            resetReason: "COMPACTION_COMMITTED",
            resetStepSequence: 3,
            resetAt: 4,
          },
        }}
      />,
    );
    const initialEpoch = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: { ...basePromptCache, resetReason: "INITIAL" },
        }}
      />,
    );
    const unreported = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: {
            ...basePromptCache,
            status: "UNREPORTED",
            latestHitRate: undefined,
            rollingHitRate: undefined,
            reusablePrefixEfficiency: undefined,
            metricsV2: {
              ...basePromptCache.metricsV2,
              previousInputCoverage: undefined,
              fullRun: {
                mainAgent: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
                allPurposes: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
              },
              warm: {
                mainAgent: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
                allPurposes: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
              },
              rolling: {
                windowSize: 10,
                mainAgent: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
                allPurposes: { requestCount: 0, hitTokens: 0, accountedTokens: 0 },
              },
              latestRequest: { purpose: "MAIN_AGENT", cacheUsageReported: false },
              usageCoverage: {
                observedRequestCount: 1,
                completeCacheUsageCount: 0,
                incompleteOrUnknownCount: 1,
                providerUsageUnreportedCount: 1,
                providerUsageWithoutCacheBreakdownCount: 0,
                failedOrCancelledWithoutUsageCount: 1,
                inProgressInvocationCount: 0,
                missingInvocationRecordCount: 0,
                legacyWithoutCacheBreakdownCount: 0,
                unidentifiedLegacySampleCount: 0,
                coverageRate: 0,
                status: "UNREPORTED",
              },
            },
            purposes: [],
          },
        }}
      />,
    );

    expect(warm).toContain("暖请求命中率（Provider Usage）");
    expect(warm).toContain("当前 Run 累计命中率");
    expect(warm).not.toContain("可复用前缀效率 100%");
    expect(warm).toContain("Usage Coverage");
    expect(warm).toContain("已上报 Token 但无 Hit/Miss 1");
    expect(warm).toContain("500 input tokens");
    expect(warm).toContain("cache hit 未上报");
    expect(warm).toContain("Previous Input Coverage Proxy（诊断代理量）");
    expect(warm).toContain("缓存周期");
    expect(warm).toContain("80.0%");
    expect(cold).toContain("冷启动");
    expect(reset).toContain("最近重置");
    expect(reset).toContain("COMPACTION_COMMITTED");
    expect(reset).toContain("Step 3");
    expect(initialEpoch).toMatch(/最近重置<\/dt><dd>—<\/dd>/);
    expect(initialEpoch).not.toContain("INITIAL");
    expect(unreported).toContain("未上报 usage");
    expect(unreported).not.toContain("0.0%");
    expect(unreported).not.toContain("可复用前缀效率");
  });

  it("keeps Purpose-specific Usage visible without claiming missing fields are zero", () => {
    const legacy = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    const withAuxiliary = renderToStaticMarkup(
      <ContextInspector usage={{ ...baseUsage, promptCache: basePromptCache }} />,
    );

    expect(legacy).toContain("工作上下文");
    expect(legacy).not.toContain("平台实际命中率");
    expect(withAuxiliary).toContain("压缩请求");
    expect(withAuxiliary).toContain("1 request");
    expect(withAuxiliary).toContain("500 input tokens");
    expect(withAuxiliary).toContain("60 input tokens");
    expect(withAuxiliary).toContain("cache hit 未上报");
    expect(withAuxiliary).toContain("Usage Coverage");
  });

  it("defines narrow-screen cache layout constraints", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.context-cache-section\s*\{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.context-cache-purpose-list\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(styles).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.context-inspector/);
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?\.context-inspector\s*\{[^}]*max-height:\s*calc\(100dvh - 120px\);[^}]*overflow-y:\s*auto/s,
    );
  });
});
