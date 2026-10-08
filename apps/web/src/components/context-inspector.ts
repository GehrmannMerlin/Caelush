import { createElement, type ReactElement } from "react";
import type { CacheMetricsV2, ContextUsageProjection } from "@caelush/protocol";

export function ContextInspector(props: { readonly usage: ContextUsageProjection }): ReactElement {
  const percentage = Math.round(props.usage.usedRatio * 100);
  return createElement(
    "div",
    { className: "context-inspector", role: "dialog", "aria-label": "工作上下文用量详情" },
    createElement(
      "div",
      { className: "context-inspector-heading" },
      createElement("strong", null, "工作上下文"),
      createElement("span", null, `${percentage}% 已使用`),
    ),
    createElement(
      "dl",
      { className: "context-inspector-grid" },
      createElement("dt", null, "模型"),
      createElement("dd", null, `${props.usage.providerId} / ${props.usage.modelId}`),
      createElement("dt", null, "Profile Source"),
      createElement("dd", null, props.usage.profileSource ?? "UNKNOWN"),
      createElement("dt", null, "容量"),
      createElement("dd", null, `${props.usage.effectiveInputLimitTokens.toLocaleString()} tokens`),
      createElement("dt", null, "Raw Context Window"),
      createElement(
        "dd",
        null,
        `${(props.usage.rawContextWindowTokens ?? props.usage.contextWindowTokens).toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Estimated Used"),
      createElement("dd", null, `${props.usage.estimatedInputTokens.toLocaleString()} tokens`),
      createElement("dt", null, "剩余"),
      createElement("dd", null, `${props.usage.remainingTokens.toLocaleString()} tokens`),
      createElement("dt", null, "压力"),
      createElement("dd", null, pressureLabel(props.usage.pressureState)),
      createElement("dt", null, "压缩"),
      createElement("dd", null, `${props.usage.compactionCount} 次`),
      createElement("dt", null, "System"),
      createElement(
        "dd",
        null,
        `${(props.usage.breakdown.systemTokens ?? props.usage.breakdown.project).toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Current Turn"),
      createElement(
        "dd",
        null,
        `${(props.usage.breakdown.currentTurnTokens ?? props.usage.breakdown.recentTail).toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Mandatory"),
      createElement(
        "dd",
        null,
        `${(props.usage.breakdown.mandatoryTokens ?? 0).toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Files"),
      createElement(
        "dd",
        null,
        `${(props.usage.breakdown.relevantFileTokens ?? props.usage.breakdown.files).toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Observations"),
      createElement(
        "dd",
        null,
        `${props.usage.breakdown.toolObservations.toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Memory"),
      createElement("dd", null, `${props.usage.breakdown.memory.toLocaleString()} tokens`),
      createElement("dt", null, "Recovery"),
      createElement("dd", null, (props.usage.lastRecoveryStages ?? []).join(" → ") || "—"),
    ),
    props.usage.promptCache === undefined
      ? null
      : createElement(PromptCacheInspector, { cache: props.usage.promptCache }),
  );
}

function PromptCacheInspector(props: {
  readonly cache: NonNullable<ContextUsageProjection["promptCache"]>;
}): ReactElement {
  const cache = props.cache;
  const statusLabel = promptCacheStatusLabel(cache.status);
  const metrics = cache.metricsV2;
  const resetReason = cache.resetReason === "INITIAL" ? undefined : cache.resetReason;
  const resetDescription =
    resetReason === undefined
      ? "—"
      : [
          resetReason,
          cache.resetStepSequence === undefined ? undefined : `Step ${cache.resetStepSequence}`,
          cache.resetAt === undefined ? undefined : new Date(Number(cache.resetAt)).toISOString(),
        ]
          .filter((part): part is string => part !== undefined)
          .join(" · ");

  return createElement(
    "section",
    { className: "context-cache-section", "aria-label": "Prompt cache usage" },
    createElement(
      "div",
      { className: "context-cache-heading" },
      createElement("strong", null, "Prompt Cache"),
      createElement("span", null, statusLabel),
    ),
    createElement(
      "dl",
      { className: "context-cache-details" },
      createElement("dt", null, "暖请求命中率（Provider Usage）"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatRate(metrics.warm.mainAgent.hitRate),
      ),
      createElement("dt", null, "当前 Run 累计命中率"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatRate(metrics.fullRun.mainAgent.hitRate),
      ),
      createElement("dt", null, "MAIN_AGENT 全程命中 / 未命中 Tokens"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatCacheTokenSplit(metrics.fullRun.mainAgent),
      ),
      createElement("dt", null, "MAIN_AGENT 暖请求命中 / 未命中 Tokens"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatCacheTokenSplit(metrics.warm.mainAgent),
      ),
      createElement("dt", null, "全部用途暖请求命中率"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatRate(metrics.warm.allPurposes.hitRate),
      ),
      createElement("dt", null, "全部用途 Run 累计命中率"),
      createElement(
        "dd",
        null,
        metrics === undefined ? "历史统计不可用" : formatRate(metrics.fullRun.allPurposes.hitRate),
      ),
      createElement("dt", null, `最近 ${metrics?.rolling.windowSize ?? 10} 次命中率`),
      createElement(
        "dd",
        null,
        metrics === undefined
          ? "历史统计不可用"
          : `${formatRate(metrics.rolling.mainAgent.hitRate)} · ${metrics.rolling.mainAgent.requestCount} 个请求`,
      ),
      createElement("dt", null, "最近请求未命中"),
      createElement(
        "dd",
        null,
        metrics?.latestRequest?.missTokens === undefined
          ? "未上报"
          : `${metrics.latestRequest.missTokens.toLocaleString()} tokens`,
      ),
      createElement("dt", null, "Usage Coverage"),
      createElement(
        "dd",
        null,
        metrics === undefined
          ? "历史统计不可用"
          : `${metrics.usageCoverage.completeCacheUsageCount} / ${metrics.usageCoverage.observedRequestCount} · ${metrics.usageCoverage.status}`,
      ),
      createElement("dt", null, "缓存周期"),
      createElement("dd", null, `${cache.epochId ?? "—"} · ${statusLabel}`),
      createElement("dt", null, "最近重置"),
      createElement("dd", null, resetDescription),
      createElement("dt", null, "Usage Coverage 诊断"),
      createElement(
        "dd",
        null,
        metrics === undefined
          ? "历史统计不可用"
          : formatUsageCoverageDetails(metrics.usageCoverage),
      ),
    ),
    metrics?.previousInputCoverage === undefined
      ? null
      : createElement(
          "p",
          { className: "context-cache-diagnostic" },
          `Previous Input Coverage Proxy（诊断代理量）：${formatRate(metrics.previousInputCoverage.coverage)}`,
        ),
    metrics?.surfaceDelta === undefined
      ? null
      : createElement(
          "p",
          { className: "context-cache-diagnostic" },
          metrics.surfaceDelta.availability === "NOT_AVAILABLE_FOR_V2"
            ? "Context Delta：旧版 V2 数据不可用"
            : `Context Delta：Baseline ${metrics.surfaceDelta.baselineCount} · Delta ${metrics.surfaceDelta.deltaCount} · NOOP ${metrics.surfaceDelta.noopCount} · SET ${metrics.surfaceDelta.setCount} · CLEAR ${metrics.surfaceDelta.clearCount} · ${metrics.surfaceDelta.newModelVisibleBytes} bytes · 估算 ${metrics.surfaceDelta.estimatedNewContextTokens} tokens`,
        ),
    createElement(
      "ul",
      { className: "context-cache-purpose-list", "aria-label": "Request purpose totals" },
      ...cache.purposes.map((purpose) =>
        createElement(
          "li",
          { className: "context-cache-purpose", key: purpose.purpose },
          createElement("strong", null, purposeLabel(purpose.purpose)),
          createElement(
            "span",
            null,
            `${purpose.requestCount.toLocaleString()} ${purpose.requestCount === 1 ? "request" : "requests"} · ${purposeUsageDetail(purpose)}`,
          ),
        ),
      ),
    ),
  );
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "未上报" : `${(value * 100).toFixed(1)}%`;
}

function formatCacheTokenSplit(rate: {
  readonly hitTokens: number;
  readonly accountedTokens: number;
}): string {
  if (rate.accountedTokens === 0) return "未上报";
  return `${rate.hitTokens.toLocaleString()} / ${(rate.accountedTokens - rate.hitTokens).toLocaleString()} tokens`;
}

function formatUsageCoverageDetails(coverage: CacheMetricsV2["usageCoverage"]): string {
  const diagnostics = [
    ["Provider 未上报 Usage", coverage.providerUsageUnreportedCount],
    ["已上报 Token 但无 Hit/Miss", coverage.providerUsageWithoutCacheBreakdownCount],
    ["失败/取消且无 Usage", coverage.failedOrCancelledWithoutUsageCount],
    ["仍在执行或未结算", coverage.inProgressInvocationCount],
    ["缺少 Gateway 调用记录", coverage.missingInvocationRecordCount],
    ["旧记录缺少 Cache 字段", coverage.legacyWithoutCacheBreakdownCount],
    ["无 Invocation ID 的样本", coverage.unidentifiedLegacySampleCount],
  ] as const;
  const visible = diagnostics
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count.toLocaleString()}`);
  return visible.length === 0 ? "未发现覆盖缺口" : visible.join(" · ");
}

function purposeUsageDetail(
  purpose: NonNullable<ContextUsageProjection["promptCache"]>["purposes"][number],
): string {
  const coverage = purpose.usageFieldCoverage;
  if (coverage === undefined) return "旧版本未保存字段上报覆盖";
  return [
    formatPurposeField("input", purpose.inputTokens, coverage.inputTokens, purpose.requestCount),
    formatPurposeField("output", purpose.outputTokens, coverage.outputTokens, purpose.requestCount),
    formatPurposeField("cache hit", purpose.hitTokens, coverage.hitTokens, purpose.requestCount),
    formatPurposeField("cache miss", purpose.missTokens, coverage.missTokens, purpose.requestCount),
    formatPurposeField(
      "cache write",
      purpose.writeTokens,
      coverage.writeTokens,
      purpose.requestCount,
    ),
    formatPurposeField(
      "reasoning",
      purpose.reasoningTokens ?? 0,
      coverage.reasoningTokens,
      purpose.requestCount,
    ),
  ].join(" · ");
}

function formatPurposeField(
  label: string,
  tokens: number,
  reportedRequestCount: number,
  requestCount: number,
): string {
  if (reportedRequestCount === 0) return `${label} 未上报`;
  return `${tokens.toLocaleString()} ${label} tokens${reportedRequestCount < requestCount ? ` (${reportedRequestCount}/${requestCount} reported)` : ""}`;
}

function promptCacheStatusLabel(
  status: NonNullable<ContextUsageProjection["promptCache"]>["status"],
): string {
  switch (status) {
    case "WARM":
      return "缓存已命中";
    case "COLD_START":
      return "冷启动";
    case "RESET":
      return "已重置";
    case "UNREPORTED":
      return "未上报 usage";
  }
}

function purposeLabel(
  purpose: NonNullable<ContextUsageProjection["promptCache"]>["purposes"][number]["purpose"],
): string {
  switch (purpose) {
    case "MAIN_AGENT":
      return "主请求";
    case "VERIFICATION_LLM":
      return "验证请求";
    case "CONTEXT_COMPACTION":
      return "上下文压缩请求";
    case "WARMUP":
      return "预热请求";
    case "RETRY":
      return "重试请求";
    case "COMPACTION":
      return "压缩请求";
    case "TITLE":
      return "标题请求";
    case "OTHER":
      return "其他请求";
  }
}

function pressureLabel(value: ContextUsageProjection["pressureState"]): string {
  switch (value) {
    case "NORMAL":
      return "正常";
    case "PROACTIVE":
      return "接近上限";
    case "EMERGENCY":
      return "紧急";
  }
}
