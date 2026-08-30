import type { RunStatus } from "@caelush/protocol";

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "VERIFYING",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "TIMEOUT"],
  VERIFYING: ["COMPLETED", "RUNNING", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
  MAX_STEPS_REACHED: [],
  BUDGET_EXCEEDED: [],
};

const terminalStatuses: readonly RunStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
];

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.includes(status);
}

export class InvalidRunStatusTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid run status transition: ${from} -> ${to}`);
    this.name = "InvalidRunStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new InvalidRunStatusTransitionError(from, to);
  }
}
