import { createElement, type ReactElement } from "react";
import type { ContextUsageProjection } from "@caelush/protocol";

export function ContextInspector(props: { readonly usage: ContextUsageProjection }): ReactElement {
  const usage = props.usage;
  const ratio = Number.isFinite(usage.usedRatio) ? Math.min(1, Math.max(0, usage.usedRatio)) : 0;
  const percentage = Math.round(ratio * 100);
  const runCacheHitRate = usage.promptCache?.metricsV2?.fullRun.mainAgent.hitRate;
  const cacheHitRate = runCacheHitRate ?? usage.promptCache?.latestHitRate;

  return createElement(
    "div",
    { className: "context-inspector", role: "dialog", "aria-label": "工作上下文用量详情" },
    createElement(
      "div",
      { className: "context-inspector-heading" },
      createElement(
        "div",
        { className: "context-inspector-heading-copy" },
        createElement("strong", null, "工作上下文"),
        createElement(
          "span",
          {
            className: `context-inspector-pressure context-inspector-pressure--${usage.pressureState}`,
          },
          pressureLabel(usage.pressureState),
        ),
      ),
      createElement("strong", { className: "context-inspector-percentage" }, `${percentage}%`),
    ),
    createElement(
      "div",
      {
        className: `context-inspector-progress context-inspector-progress--${usage.pressureState}`,
        role: "progressbar",
        "aria-label": "上下文容量使用率",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": percentage,
        "aria-valuetext": `${percentage}% 已用，${usage.estimatedInputTokens.toLocaleString()} / ${usage.effectiveInputLimitTokens.toLocaleString()} tokens`,
      },
      createElement("span", { style: { width: `${percentage}%` } }),
    ),
    createElement(
      "div",
      { className: "context-inspector-capacity" },
      createElement("span", null, "估算已用"),
      createElement(
        "strong",
        null,
        `${usage.estimatedInputTokens.toLocaleString()} / ${usage.effectiveInputLimitTokens.toLocaleString()} tokens`,
      ),
    ),
    createElement(
      "div",
      { className: "context-inspector-capacity context-inspector-capacity--remaining" },
      createElement("span", null, "剩余"),
      createElement("strong", null, `${usage.remainingTokens.toLocaleString()} tokens`),
    ),
    createElement(
      "div",
      { className: "context-inspector-metrics", "aria-label": "其他关键指标" },
      createElement(
        "div",
        { className: "context-inspector-metric" },
        createElement("span", null, "缓存命中率"),
        createElement("strong", null, formatRate(cacheHitRate)),
        createElement(
          "small",
          null,
          cacheMetricSource(runCacheHitRate, usage.promptCache?.latestHitRate),
        ),
      ),
      createElement(
        "div",
        { className: "context-inspector-metric" },
        createElement("span", null, "上下文压缩"),
        createElement("strong", null, `${usage.compactionCount.toLocaleString()} 次`),
      ),
    ),
  );
}

function formatRate(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "暂无数据"
    : `${(value * 100).toFixed(1)}%`;
}

function cacheMetricSource(runRate: number | undefined, latestRate: number | undefined): string {
  if (runRate !== undefined && Number.isFinite(runRate)) return "当前 Run";
  return latestRate === undefined || !Number.isFinite(latestRate) ? "暂无缓存数据" : "最近请求";
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
