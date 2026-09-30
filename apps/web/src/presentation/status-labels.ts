import type { RiskLevel, TurnPresentationItemStatus } from "@caelush/protocol";

/** Browser-facing labels for protocol-owned values. Raw enum codes stay internal to control logic. */
export function approvalRiskLabel(level: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    LOW: "低风险",
    MEDIUM: "中风险",
    HIGH: "高风险",
    CRITICAL: "严重风险",
  };
  return labels[level];
}

export function presentationStatusLabel(status: TurnPresentationItemStatus): string {
  const labels: Record<TurnPresentationItemStatus, string> = {
    STREAMING: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
  };
  return labels[status];
}

export function toolStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    REQUESTED: "已请求",
    WAITING_APPROVAL: "等待批准",
    WAITING_RESOURCE: "等待资源",
    RUNNING: "运行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
  };
  return labels[status] ?? "未知状态";
}

export function verificationStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    ACTIVE: "进行中",
    REQUESTED: "已请求",
    RUNNING: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    PENDING: "等待中",
    SKIPPED: "已跳过",
    INTERRUPTED: "已中断",
    RESOLVED: "已处理",
    FINALIZED: "已结束",
    PASSED: "通过",
    ERROR: "错误",
  };
  return labels[status] ?? "未知状态";
}
