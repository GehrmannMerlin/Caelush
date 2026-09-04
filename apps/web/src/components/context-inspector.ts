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
  );
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
