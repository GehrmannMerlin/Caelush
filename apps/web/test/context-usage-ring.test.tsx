import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRunId } from "@caelush/protocol";
import type { ContextUsageProjection, PromptCacheUsage } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextUsageRing } from "../src/components/context-usage-ring.js";
import { ContextInspector, ContextRunProcessPanel } from "../src/components/context-inspector.js";
import { PromptComposer } from "../src/components/prompt-composer.js";
import { SessionWorkspace } from "../src/components/session-workspace.js";
import { createInitialTimelineState } from "@caelush/client";
import { resolveClientHostIntegration } from "../src/host/desktop-integration.js";

const baseUsage: ContextUsageProjection = {
  runId: createRunId(),
  providerId: "fixture",
  modelId: "small",
  contextWindowTokens: 1000,
  rawContextWindowTokens: 1200,
  effectiveInputLimitTokens: 800,
  estimatedInputTokens: 400,
  usedRatio: 0.5,
  fullRequestInputEstimateTokens: 500,
  fullWindowUsedRatio: 0.4166666666666667,
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
  it("keeps correction text out of the compact control while retaining inspector details", () => {
    const process = { kind: "CORRECTING", cause: "TOOL_FEEDBACK" } as const;
    const markup = renderToStaticMarkup(<ContextUsageRing usage={baseUsage} process={process} />);
    const details = renderToStaticMarkup(
      <ContextRunProcessPanel runId={baseUsage.runId} process={process} />,
    );

    expect(markup).toContain('aria-label="工作上下文用量：42%"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("正在根据反馈修正");
    expect(markup).not.toContain("context-usage-live-process");
    expect(details).toContain("工具返回问题，正在根据具体反馈修正");
  });

  it("renders total model-window usage while keeping input budget details separate", () => {
    const markup = renderToStaticMarkup(<ContextUsageRing usage={baseUsage} />);
    const inspectorMarkup = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    expect(markup).toContain('aria-label="工作上下文用量：42%"');
    expect(markup).toContain('viewBox="0 0 18 18"');
    expect(markup).toContain('stroke-dashoffset="0.5833333333333333"');
    expect(markup).toContain("工作上下文");
    expect(inspectorMarkup).toContain('role="progressbar"');
    expect(inspectorMarkup).toContain('aria-valuenow="42"');
    expect(inspectorMarkup).toContain("42%");
    expect(inspectorMarkup).toContain("500 / 1,200 tokens");
    expect(inspectorMarkup).toContain("可用输入预算");
    expect(inspectorMarkup).toContain("400 tokens");
    expect(inspectorMarkup).toContain("缓存命中率");
    expect(inspectorMarkup).toContain("上下文压缩");
    expect(inspectorMarkup).not.toContain("Current Turn");
    expect(inspectorMarkup).not.toContain("Raw Context Window");
  });

  it("keeps the shared context control in the Desktop-mode workbench shell", () => {
    const host = resolveClientHostIntegration({
      caelushDesktop: { protocolVersion: 1 },
    });
    expect(host.kind).toBe("DESKTOP");

    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="桌面工作台"
        workspaces={[]}
        onAddWorkspace={() => undefined}
        onSelectWorkspace={() => undefined}
        activeRun={{ id: baseUsage.runId, status: "RUNNING" } as never}
        history={[]}
        timeline={createInitialTimelineState(baseUsage.runId)}
        composer={
          <PromptComposer
            disabled
            submission="ACTIVE"
            onSubmit={async () => false}
            contextUsage={baseUsage}
          />
        }
      />,
    );

    expect(html).toContain('class="session-workspace"');
    expect(html).toContain('aria-label="工作上下文用量：42%"');
    expect(html).toContain('aria-label="运行中"');
  });

  it("explains the exact per-turn input and output headroom decision", () => {
    const markup = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          turnBudget: {
            version: "TURN_BUDGET_DECISION_V1",
            algorithm: "HEADROOM_V1",
            windowTokens: 1_000_000,
            inputTokens: 80_000,
            outputAllowanceTokens: 16_384,
            safetyTokens: 4_096,
            expectedGrowthTokens: 8_192,
            remainingTokens: 899_520,
            decision: "KEEP",
            windowSource: "MODEL_LIMITS",
            outputSource: "PREFERRED_ALLOWANCE",
            safetySource: "HEADROOM_V1_SAFETY",
            growthSource: "HEADROOM_V1_EXPECTED_GROWTH",
          },
        }}
      />,
    );
    expect(markup).toContain("HEADROOM_V1");
    expect(markup).toContain("输入 P 80,000");
    expect(markup).toContain("输出 O 16,384");
    expect(markup).toContain("安全余量 S 4,096");
    expect(markup).toContain("下轮增长预估 G 8,192");
    expect(markup).toContain("保留当前历史");
  });

  it("shows a degraded continuation with a readable, scoped source reference", () => {
    const sourceRef = "history:v1:run_00000000-0000-7000-8000-000000000000:1:4#1234567890abcdef";
    const markup = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          process: { kind: "DEGRADED_CONTINUATION", sourceRefs: [sourceRef] },
        }}
        onReadHistory={async () => ({
          kind: "PAGE",
          items: [
            {
              messageId: "msg_1",
              sequence: 1,
              role: "USER",
              text: "请继续完成并运行测试",
              byteLength: 30,
            },
          ],
          sourceRef,
          integrity: "VERIFIED",
          byteCount: 30,
        })}
      />,
    );
    expect(markup).toContain("任务正在降级接续");
    expect(markup).toContain("history:v1:");
    expect(markup).toContain("查看原文");
    expect(markup).toContain("可回查引用");
  });

  it("explains the trigger and quality of the latest committed summary", () => {
    const markup = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          lastCompaction: { reason: "FORCED_PROVIDER_OVERFLOW", quality: "DEGRADED" },
        }}
      />,
    );

    expect(markup).toContain("模型服务提示本轮输入超出窗口");
    expect(markup).toContain("降级摘要");
  });

  it("shows live compaction progress and its trigger even before a usage snapshot exists", () => {
    const markup = renderToStaticMarkup(
      <ContextRunProcessPanel
        runId={baseUsage.runId}
        process={{
          kind: "COMPACTING",
          stage: "SUMMARIZING",
          reason: "SELECTION_PRESSURE",
        }}
      />,
    );

    expect(markup).toContain('aria-label="上下文整理状态"');
    expect(markup).toContain("正在生成并校验历史摘要");
    expect(markup).toContain("当前可选信息过多，需要整理历史");
  });

  it("offers a read-only retry for an unconfirmed operation", () => {
    const markup = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          process: {
            kind: "ACTION_REQUIRED",
            reason: "EFFECT_UNCONFIRMED",
            toolName: "apply_patch",
            reasonCode: "INCONCLUSIVE",
          },
        }}
        onContinueResourceGuard={async () => true}
      />,
    );
    expect(markup).toContain("操作的结果暂时无法确认");
    expect(markup).toContain("apply_patch");
    expect(markup).toContain("只读核对并继续");
    expect(markup).toContain("不会自动重放");
  });

  it("shows a persistent provider cooldown with its saved progress", () => {
    const markup = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          process: {
            kind: "PROVIDER_WAIT",
            nextAttemptAt: Date.now() + 60_000,
            episode: 2,
            totalAttempts: 6,
            errorCode: "LLM_NETWORK",
          },
        }}
      />,
    );
    expect(markup).toContain("模型服务连续不可用，任务已保存并等待自动接续");
    expect(markup).toContain("第 2 段重试");
    expect(markup).toContain("此前已失败 6 次");
    expect(markup).toContain("LLM_NETWORK");
  });

  it("clamps invalid ratios to the visible 0%–100% ring range", () => {
    const overfull = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, fullWindowUsedRatio: 1.4 }} />,
    );
    const negative = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, fullWindowUsedRatio: -0.2 }} />,
    );
    expect(overfull).toContain('stroke-dashoffset="0"');
    expect(negative).toContain('stroke-dashoffset="1"');
  });

  it("shows the current Run cache hit rate and handles unavailable metrics", () => {
    const warm = renderToStaticMarkup(
      <ContextInspector usage={{ ...baseUsage, promptCache: basePromptCache }} />,
    );
    const latestOnly = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: { ...basePromptCache, metricsV2: undefined },
        }}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          promptCache: {
            ...basePromptCache,
            latestHitRate: undefined,
            metricsV2: undefined,
          },
        }}
      />,
    );

    expect(warm).toContain("缓存命中率");
    expect(warm).toContain("80.0%");
    expect(warm).toContain("当前 Run");
    expect(warm).not.toContain("Usage Coverage");
    expect(warm).not.toContain("MAIN_AGENT");
    expect(warm).not.toContain("500 input tokens");
    expect(latestOnly).toContain("80.0%");
    expect(latestOnly).toContain("最近请求");
    expect(unavailable).toContain("暂无数据");
    expect(unavailable).not.toContain("0.0%");
  });

  it("keeps the popover focused on capacity, cache rate, and compactions", () => {
    const current = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    const withAuxiliary = renderToStaticMarkup(
      <ContextInspector usage={{ ...baseUsage, promptCache: basePromptCache }} />,
    );

    expect(current).toContain("工作上下文");
    expect(current).toContain("42%");
    expect(withAuxiliary).toContain("80.0%");
    expect(withAuxiliary).toContain("1 次");
    expect(withAuxiliary).toContain("正常");
    expect(withAuxiliary).not.toContain("压缩请求");
    expect(withAuxiliary).not.toContain("request");
    expect(withAuxiliary).not.toContain("Usage Coverage");
  });

  it("labels snapshots without full-window telemetry as legacy estimates", () => {
    const legacy = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          fullRequestInputEstimateTokens: undefined,
          fullWindowUsedRatio: undefined,
          pressureState: "PROACTIVE",
        }}
      />,
    );

    expect(legacy).toContain("旧版估算");
    expect(legacy).toContain("33%");
    expect(legacy).toContain("400 / 1,200 tokens");
    expect(legacy).toContain("接近上限");
  });

  it("clamps zero and overfull total-window ratios without changing pressure state", () => {
    const zero = renderToStaticMarkup(
      <ContextInspector
        usage={{
          ...baseUsage,
          fullRequestInputEstimateTokens: 0,
          fullWindowUsedRatio: 0,
          pressureState: "PROACTIVE",
        }}
      />,
    );
    const overfull = renderToStaticMarkup(
      <ContextUsageRing
        usage={{
          ...baseUsage,
          fullRequestInputEstimateTokens: 1_500,
          fullWindowUsedRatio: 1,
        }}
      />,
    );

    expect(zero).toContain("0%");
    expect(zero).toContain("接近上限");
    expect(overfull).toContain('aria-label="工作上下文用量：100%"');
    expect(overfull).toContain('stroke-dashoffset="0"');
  });

  it("keeps the compact inspector usable on narrow screens", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.context-inspector-progress\s*\{[^}]*height:\s*7px/s);
    expect(styles).toMatch(/\.context-inspector-metrics\s*\{[^}]*grid-template-columns:/s);
    expect(styles).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.context-inspector/);
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?\.context-inspector\s*\{[^}]*max-height:\s*calc\(100dvh - 100px\);[^}]*overflow-y:\s*auto/s,
    );
  });
});
