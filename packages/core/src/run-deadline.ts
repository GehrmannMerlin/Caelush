import type { AgentRun, TimestampMs } from "@caelush/protocol";

export interface RunDeadline {
  readonly startedAt: TimestampMs;
  readonly timeoutMs: number;
  readonly deadlineAt: TimestampMs;
}

export class RunDeadlineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDeadlineInvariantError";
  }
}

export function deriveRunDeadline(run: AgentRun): RunDeadline | undefined {
  if (run.startedAt === undefined) return undefined;
  const { startedAt } = run;
  const timeoutMs =
    run.resourcePolicy?.mode === "ADAPTIVE"
      ? run.resourcePolicy.hardLimits.maxWallClockMs
      : run.limits.timeoutMs;
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RunDeadlineInvariantError("Run timeoutMs must be a safe positive integer.");
  }
  const deadlineAt = startedAt + timeoutMs;
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new RunDeadlineInvariantError("Run deadline exceeds the safe integer range.");
  }
  return { startedAt, timeoutMs, deadlineAt: deadlineAt as TimestampMs };
}

export function isRunDeadlineExceeded(deadline: RunDeadline, now: TimestampMs): boolean {
  return now >= deadline.deadlineAt;
}

export function remainingRunTimeMs(deadline: RunDeadline, now: TimestampMs): number {
  return Math.max(0, deadline.deadlineAt - now);
}
