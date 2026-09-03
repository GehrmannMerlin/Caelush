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

export function runStatusGlyph(status: RunStatus): string {
  const glyphs: Record<RunStatus, string> = {
    PENDING: "○",
    RUNNING: "●",
    WAITING_APPROVAL: "!",
    WAITING_RESOURCE: "◫",
    VERIFYING: "◌",
    COMPLETED: "✓",
    FAILED: "×",
    CANCELLED: "⊘",
    TIMEOUT: "⌁",
    MAX_STEPS_REACHED: "≡",
    BUDGET_EXCEEDED: "!",
  };
  return glyphs[status];
}
