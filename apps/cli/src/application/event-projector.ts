import type { AgentEvent, RunStatus } from "@caelush/protocol";
import type { CliActivity, CliViewState } from "./cli-state.js";
import type { CliTimelineEntry } from "./timeline-model.js";
import { flushTimelineForTerminal, reduceTimelineEvent } from "./timeline-reducer.js";

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
  const reducedTimeline = reduceTimelineEvent(state.timeline, event);
  const terminalStatus =
    lifecycle === undefined || !lifecycle.terminal ? undefined : asTerminalStatus(lifecycle.status);
  const timeline =
    terminalStatus === undefined
      ? reducedTimeline
      : flushTimelineForTerminal(reducedTimeline, terminalStatus);
  const nextStateWithTimeline = appendSettledTimeline(state, timeline);
  if (lifecycle === undefined) {
    return { state: nextStateWithTimeline, terminal: false };
  }

  const nextState: CliViewState = {
    ...nextStateWithTimeline,
    activeRun: { runId: event.runId, status: lifecycle.status },
    activity: activityForStatus(lifecycle.status, lifecycle.activity),
    ...(lifecycle.status === "WAITING_RESOURCE"
      ? { controlMode: "RESOURCE_GUARD" as const, composerEnabled: false }
      : lifecycle.status === "RUNNING" && state.controlMode === "RESOURCE_GUARD"
        ? { controlMode: "NONE" as const }
        : {}),
  };
  if (lifecycle.terminal) {
    return { state: nextState, terminal: true, terminalStatus: lifecycle.status };
  }
  return { state: nextState, terminal: false };
}

function appendSettledTimeline(
  state: CliViewState,
  timeline: CliViewState["timeline"],
): CliViewState {
  const known = new Set(state.displayHistory.filter(isTimelineEntry).map((entry) => entry.id));
  const additions = timeline.settled.filter((entry) => !known.has(entry.id));
  return {
    ...state,
    timeline,
    ...(additions.length === 0 ? {} : { displayHistory: [...state.displayHistory, ...additions] }),
  };
}

function isTimelineEntry(entry: CliViewState["displayHistory"][number]): entry is CliTimelineEntry {
  return entry.kind !== "USER" && entry.kind !== "ASSISTANT" && entry.kind !== "RUN_TERMINAL";
}

function asTerminalStatus(
  status: RunStatus,
): Parameters<typeof flushTimelineForTerminal>[1] | undefined {
  return isTerminal(status) ? status : undefined;
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
    case "resource.guard":
      return {
        status: "WAITING_RESOURCE",
        activity: "Waiting for resource decision",
        terminal: false,
      };
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
    case "WAITING_RESOURCE":
      return "Waiting for resource decision";
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

function isTerminal(status: RunStatus): status is Parameters<typeof flushTimelineForTerminal>[1] {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}
