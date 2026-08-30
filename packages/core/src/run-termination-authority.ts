import type { AgentRun, RunCancellationIntent, TimestampMs } from "@caelush/protocol";
import { deriveRunDeadline, isRunDeadlineExceeded } from "./run-deadline.js";

export type RunExecutionAbortCause = "USER_REQUESTED" | "DEADLINE_EXCEEDED";
export type RunTerminationAuthority = "TERMINAL" | "CANCELLED" | "TIMEOUT" | "UNEXPECTED_ABORT";

export interface ResolveRunTerminationAuthorityInput {
  readonly run: AgentRun;
  readonly cancellationIntent?: RunCancellationIntent;
  readonly now: TimestampMs;
  readonly aborted?: boolean;
  readonly abortCause?: RunExecutionAbortCause;
}

export function resolveRunTerminationAuthority(
  input: ResolveRunTerminationAuthorityInput,
): RunTerminationAuthority | undefined {
  if (isTerminal(input.run.status)) return "TERMINAL";
  if (input.cancellationIntent !== undefined) return "CANCELLED";
  const deadline = deriveRunDeadline(input.run);
  if (deadline !== undefined && isRunDeadlineExceeded(deadline, input.now)) return "TIMEOUT";
  if (input.aborted === true && input.abortCause === undefined) return "UNEXPECTED_ABORT";
  if (input.aborted === true && input.abortCause === "USER_REQUESTED") return "CANCELLED";
  return undefined;
}

function isTerminal(status: AgentRun["status"]): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}
