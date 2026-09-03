import type { RunStatus } from "@caelush/protocol";

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}

export function canCancelRunStatus(status: RunStatus): boolean {
  return (
    status === "RUNNING" ||
    status === "WAITING_APPROVAL" ||
    status === "WAITING_RESOURCE" ||
    status === "VERIFYING"
  );
}

export function canContinueResourceGuard(status: RunStatus): boolean {
  return status === "WAITING_RESOURCE";
}
