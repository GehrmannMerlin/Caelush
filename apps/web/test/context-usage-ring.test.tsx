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
      unknownUsageCount: 1,
    },
  ],
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
          },
        }}
      />,
    );

    expect(warm).toContain("平台实际命中率");
    expect(warm).toContain("Caelush 可复用前缀效率");
    expect(warm).toContain("缓存周期");
    expect(warm).toContain("80%");
    expect(cold).toContain("冷启动");
    expect(reset).toContain("最近重置");
    expect(reset).toContain("COMPACTION_COMMITTED");
    expect(reset).toContain("Step 3");
    expect(initialEpoch).toMatch(/最近重置<\/dt><dd>—<\/dd>/);
    expect(initialEpoch).not.toContain("INITIAL");
    expect(unreported).toContain("未上报 usage");
    expect(unreported).not.toContain("rolling 0%");
    expect(unreported).not.toContain("latest 0%");
    expect(unreported).toMatch(/Caelush 可复用前缀效率<\/dt><dd>未上报 usage/);
  });

  it("keeps legacy Context Usage and auxiliary request totals visible", () => {
    const legacy = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    const withAuxiliary = renderToStaticMarkup(
      <ContextInspector usage={{ ...baseUsage, promptCache: basePromptCache }} />,
    );

    expect(legacy).toContain("工作上下文");
    expect(legacy).not.toContain("平台实际命中率");
    expect(withAuxiliary).toContain("压缩请求");
    expect(withAuxiliary).toContain("2 requests");
    expect(withAuxiliary).toContain("560 input tokens");
    expect(withAuxiliary).toContain("25 output tokens");
    expect(withAuxiliary).toContain("1 unknown");
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
