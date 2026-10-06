import { createElement, type ReactElement } from "react";
import type { ContextUsageProjection } from "@caelush/protocol";

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
  const platformRate =
    cache.rollingHitRate === undefined && cache.latestHitRate === undefined
      ? "未上报 usage"
      : `rolling ${formatRate(cache.rollingHitRate)} · latest ${formatRate(cache.latestHitRate)}`;
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
      createElement("dt", null, "平台实际命中率"),
      createElement("dd", null, platformRate),
      createElement("dt", null, "Caelush 可复用前缀效率"),
      createElement("dd", null, formatRate(cache.reusablePrefixEfficiency)),
      createElement("dt", null, "缓存周期"),
      createElement("dd", null, `${cache.epochId ?? "—"} · ${statusLabel}`),
      createElement("dt", null, "最近重置"),
      createElement("dd", null, resetDescription),
      createElement("dt", null, "Requests / tokens"),
      createElement(
        "dd",
        null,
        `${cache.totalRequestCount.toLocaleString()} requests · ${cache.totalInputTokens.toLocaleString()} input tokens · ${cache.totalOutputTokens.toLocaleString()} output tokens`,
      ),
      createElement("dt", null, "Cache samples"),
      createElement("dd", null, cache.sampleCount.toLocaleString()),
      createElement("dt", null, "Hit / miss / write tokens"),
      createElement(
        "dd",
        null,
        `${cache.hitTokens.toLocaleString()} / ${cache.missTokens.toLocaleString()} / ${cache.writeTokens.toLocaleString()}`,
      ),
      createElement("dt", null, "未上报 usage"),
      createElement("dd", null, cache.unknownUsageCount.toLocaleString()),
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
            `${purpose.requestCount.toLocaleString()} ${purpose.requestCount === 1 ? "request" : "requests"} · ${purpose.inputTokens.toLocaleString()} input tokens · ${purpose.outputTokens.toLocaleString()} output tokens · ${purpose.unknownUsageCount.toLocaleString()} unknown`,
          ),
        ),
      ),
    ),
  );
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "未上报 usage" : `${Math.round(value * 100)}%`;
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
