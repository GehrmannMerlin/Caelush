import { createElement, type ReactElement } from "react";
import type { ApprovalResolution } from "@caelush/protocol";
import type { ApprovalOptionKind, ApprovalView } from "@caelush/client";

export interface ApprovalCardProps {
  readonly approval: ApprovalView;
  readonly onResolve: (
    approvalId: ApprovalView["id"],
    resolution: ApprovalResolution,
  ) => Promise<boolean> | void;
}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps): ReactElement {
  const button = (kind: ApprovalOptionKind, label: string) =>
    approval.options.some((option) => option.kind === kind)
      ? createElement(
          "button",
          {
            type: "button",
            className: `approval-action approval-action--${kind.toLowerCase()}`,
            onClick: () => void onResolve(approval.id, resolutionFor(kind)),
          },
          label,
        )
      : null;
  return createElement(
    "article",
    { className: "approval-card", "aria-labelledby": `approval-${approval.id}` },
    createElement("p", { className: "approval-kicker" }, "需要审批"),
    createElement("h2", { id: `approval-${approval.id}` }, approval.title),
    createElement(
      "dl",
      { className: "approval-details" },
      createElement("dt", null, "风险"),
      createElement("dd", null, approval.riskLevel),
      createElement("dt", null, "原因"),
      createElement("dd", null, approval.reason),
      createElement("dt", null, "动作"),
      createElement("dd", null, approval.summary ?? approval.toolName ?? "未命名动作"),
      approval.toolName === undefined ? null : createElement("dt", null, "工具"),
      approval.toolName === undefined ? null : createElement("dd", null, approval.toolName),
    ),
    approval.requiredCapabilities.length === 0
      ? null
      : createElement(
          "ul",
          { className: "approval-capabilities", "aria-label": "所需能力" },
          approval.requiredCapabilities.map((capability) =>
            createElement("li", { key: capability }, capability),
          ),
        ),
    createElement(
      "div",
      { className: "approval-actions" },
      button("REJECT", "拒绝"),
      button("APPROVE_ONCE", "仅本次允许"),
      button("APPROVE_RUN", "本次运行内允许"),
    ),
  );
}

function resolutionFor(kind: ApprovalOptionKind): ApprovalResolution {
  return kind === "REJECT"
    ? { action: "REJECT" }
    : { action: "APPROVE", scope: kind === "APPROVE_RUN" ? "RUN" : "ONCE" };
}
