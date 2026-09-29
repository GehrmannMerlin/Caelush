import { createElement, type ReactElement } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  LoaderCircle,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import type { RunStatus } from "@caelush/protocol";

export function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    PENDING: "准备中",
    RUNNING: "运行中",
    WAITING_APPROVAL: "等待审批",
    WAITING_RESOURCE: "等待资源决策",
    VERIFYING: "验证中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    TIMEOUT: "已超时",
    MAX_STEPS_REACHED: "达到步骤上限",
    BUDGET_EXCEEDED: "达到预算限制",
  };
  return labels[status];
}

export function runStatusClass(status: RunStatus): string {
  return `run-status--${status.toLowerCase()}`;
}

export function runStatusIcon(status: RunStatus): LucideIcon {
  switch (status) {
    case "PENDING":
      return CircleDot;
    case "RUNNING":
      return LoaderCircle;
    case "WAITING_APPROVAL":
      return CircleAlert;
    case "WAITING_RESOURCE":
      return Clock3;
    case "VERIFYING":
      return LoaderCircle;
    case "COMPLETED":
      return CircleCheck;
    case "FAILED":
    case "CANCELLED":
    case "TIMEOUT":
      return CircleX;
    case "MAX_STEPS_REACHED":
      return ListChecks;
    case "BUDGET_EXCEEDED":
      return CircleAlert;
  }
}

export function RunStatusIcon(props: {
  readonly status: RunStatus;
  readonly size?: number;
}): ReactElement {
  const Icon = runStatusIcon(props.status);
  return createElement(Icon, {
    size: props.size ?? 16,
    strokeWidth: 2.15,
    "aria-hidden": true,
    focusable: false,
  });
}
