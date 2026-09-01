import type { AgentEvent, RunStatus } from "@caelush/protocol";
import type { CliActivity, CliViewState } from "./cli-state.js";

export interface CliEventProjection {
  readonly state: CliViewState;
  readonly terminal: boolean;
  readonly terminalStatus?: RunStatus;
}

export function projectAgentEvent(state: CliViewState, event: AgentEvent): CliEventProjection {
  if (state.activeRun === undefined || state.activeRun.runId !== event.runId) {
    return { state, terminal: false };
  }

  const lifecycle = lifecycleForEvent(event);
  if (lifecycle === undefined) return { state, terminal: false };

  const nextState: CliViewState = {
    ...state,
    activeRun: { runId: event.runId, status: lifecycle.status },
    activity: activityForStatus(lifecycle.status, lifecycle.activity),
  };
  if (lifecycle.terminal) {
    return { state: nextState, terminal: true, terminalStatus: lifecycle.status };
  }
  return { state: nextState, terminal: false };
}

interface EventLifecycle {
  readonly status: RunStatus;
  readonly activity?: CliActivity;
  readonly terminal: boolean;
}

function lifecycleForEvent(event: AgentEvent): EventLifecycle | undefined {
  switch (event.type) {
    case "status.changed":
      return {
        status: event.payload.to,
        terminal: isTerminal(event.payload.to),
      };
    case "run.started":
      return { status: "RUNNING", activity: "Working", terminal: false };
    case "run.completed":
      return { status: "COMPLETED", terminal: true };
    case "run.failed":
      return { status: "FAILED", terminal: true };
    case "run.cancelled":
      return { status: "CANCELLED", terminal: true };
    case "run.timed_out":
      return { status: "TIMEOUT", terminal: true };
    case "budget.exceeded":
      return { status: "BUDGET_EXCEEDED", terminal: true };
    case "retry.scheduled":
    case "retry.started":
      return { status: "RUNNING", activity: "Retrying", terminal: false };
    case "verification.started":
    case "verification.check.started":
    case "verification.planned":
      return { status: "VERIFYING", activity: "Verifying", terminal: false };
    case "approval.requested":
      return { status: "WAITING_APPROVAL", activity: "Approval required", terminal: false };
    case "llm.started":
      return { status: "RUNNING", activity: "Working", terminal: false };
    default:
      return undefined;
  }
}

function activityForStatus(status: RunStatus, explicit?: CliActivity): CliActivity {
  if (explicit !== undefined) return explicit;
  switch (status) {
    case "PENDING":
      return "Preparing";
    case "RUNNING":
      return "Working";
    case "WAITING_APPROVAL":
      return "Approval required";
    case "VERIFYING":
      return "Verifying";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    case "TIMEOUT":
      return "Timed out";
    case "MAX_STEPS_REACHED":
      return "Max steps reached";
    case "BUDGET_EXCEEDED":
      return "Budget exceeded";
  }
}

function isTerminal(status: RunStatus): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}
