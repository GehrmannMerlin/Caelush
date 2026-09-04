import { createElement, useState, type ReactElement } from "react";
import type { ContextUsageProjection } from "@caelush/protocol";
import { ContextInspector } from "./context-inspector.js";

export function ContextUsageRing(props: {
  readonly usage?: ContextUsageProjection | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ratio = props.usage?.usedRatio ?? 0;
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
        { className: "context-usage-ring", viewBox: "0 0 14 14", "aria-hidden": "true" },
        createElement("circle", { className: "context-usage-ring-track", cx: 7, cy: 7, r: 5 }),
        createElement("circle", {
          className: `context-usage-ring-progress context-usage-ring-progress--${props.usage?.pressureState ?? "EMPTY"}`,
          cx: 7,
          cy: 7,
          r: 5,
          pathLength: 1,
          strokeDasharray: 1,
          strokeDashoffset: 1 - ratio,
        }),
      ),
    ),
    open && props.usage != null ? createElement(ContextInspector, { usage: props.usage }) : null,
  );
}
