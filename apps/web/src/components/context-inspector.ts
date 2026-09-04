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
      createElement("dt", null, "容量"),
      createElement("dd", null, `${props.usage.effectiveInputLimitTokens.toLocaleString()} tokens`),
      createElement("dt", null, "剩余"),
      createElement("dd", null, `${props.usage.remainingTokens.toLocaleString()} tokens`),
      createElement("dt", null, "压力"),
      createElement("dd", null, pressureLabel(props.usage.pressureState)),
      createElement("dt", null, "压缩"),
      createElement("dd", null, `${props.usage.compactionCount} 次`),
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
