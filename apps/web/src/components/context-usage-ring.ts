import { createElement, useState, type ReactElement } from "react";
import type { ContextUsageProjection } from "@caelush/protocol";
import { ContextInspector } from "./context-inspector.js";

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function ContextUsageRing(props: {
  readonly usage?: ContextUsageProjection | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ratio = clampRatio(props.usage?.usedRatio ?? 0);
  const label =
    props.usage == null
      ? "工作上下文用量：暂无数据"
      : `工作上下文用量：${Math.round(ratio * 100)}%`;
  return createElement(
    "span",
    { className: "context-usage-control" },
    createElement(
      "button",
      {
        type: "button",
        className: "context-usage-ring-button",
        "aria-label": label,
        "aria-expanded": open,
        title: label,
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.key === "Escape") setOpen(false);
        },
      },
      createElement(
        "svg",
        { className: "context-usage-ring", viewBox: "0 0 18 18", "aria-hidden": "true" },
        createElement("circle", { className: "context-usage-ring-track", cx: 9, cy: 9, r: 7 }),
        createElement("circle", {
          className: `context-usage-ring-progress context-usage-ring-progress--${props.usage?.pressureState ?? "EMPTY"}`,
          cx: 9,
          cy: 9,
          r: 7,
          pathLength: 1,
          strokeDasharray: 1,
          strokeDashoffset: 1 - ratio,
        }),
      ),
    ),
    open && props.usage != null ? createElement(ContextInspector, { usage: props.usage }) : null,
  );
}
