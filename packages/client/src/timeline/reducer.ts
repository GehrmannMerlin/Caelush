import type { AgentEvent, RunStatus } from "@caelush/protocol";
import type {
  TimelineEntry,
  TimelineEntryStatus,
  TimelineRetry,
  TimelineState,
  TimelineVerificationCheck,
  TimelineVerificationGroup,
} from "./model.js";
import {
  formatFileChange,
  formatFileMove,
  formatFileRead,
  formatToolLabel,
  sanitizeTerminalText,
  truncateTimelineText,
} from "./presentation.js";

const ORDER_ERROR = "Timeline event order could not be verified.";
const OMITTED_MARKER = "… additional activity omitted …";
type TerminalStatus = Extract<
  RunStatus,
  "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED" | "BUDGET_EXCEEDED"
>;

export function reduceTimelineEvent(state: TimelineState, event: AgentEvent): TimelineState {
  if (state.error !== undefined) return state;
  if (state.runId !== undefined && state.runId !== event.runId) return state;
  if (event.visibility !== "USER_VISIBLE") return state;
  const registration = registerEvent(state, event);
  if (registration.kind === "DUPLICATE") return state;
  if (registration.kind === "CONFLICT") return { ...state, error: ORDER_ERROR };
  if (registration.kind !== "NEW") return state;
  return reduceRegisteredEvent(registration.state, event);
}

export function flushTimelineForTerminal(
  state: TimelineState,
  status: TerminalStatus,
): TimelineState {
  let next = state;
  for (const entry of [
    ...state.activeTools,
    ...state.activeLlm,
    ...state.activeApprovals,
    ...state.activeProcesses,
  ]) {
    next = appendSettled(next, {
      ...entry,
      status: "INTERRUPTED",
      text: `${entry.title ?? entry.kind} · Interrupted by ${status}.`,
    });
  }
  for (const retry of state.retries)
    next = appendSettled(next, {
      id: `retry:${retry.id}`,
      kind: "RETRY",
      title: "Retry",
      text: `Retry ${retry.attempt} · Interrupted by ${status}.`,
      status: "INTERRUPTED",
    });
  for (const group of state.verification)
    next = appendSettled(next, {
      id: `verification:${group.id}`,
      kind: "VERIFICATION",
      title: group.label,
      text: `Verification interrupted by ${status}.`,
      status: "INTERRUPTED",
    });
  return {
    ...next,
    settled: next.settled.map((entry) =>
      entry.status === "RUNNING" ? { ...entry, status: "INTERRUPTED" } : entry,
    ),
    activeTools: [],
    activeLlm: [],
    activeApprovals: [],
    activeProcesses: [],
    retries: [],
    verification: [],
    currentPlan: [],
  };
}

function reduceRegisteredEvent(state: TimelineState, event: AgentEvent): TimelineState {
  switch (event.type) {
    case "reasoning.summary":
      return reduceReasoning(state, event);
    case "llm.started":
      return upsertActive(state, "activeLlm", {
        id: llmId(event),
        kind: "LLM",
        title: "Model",
        text: `${event.payload.model.provider}/${event.payload.model.model}`,
        status: "RUNNING",
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      });
    case "llm.completed":
      return settleActive(
        state,
        "activeLlm",
        llmId(event),
        "COMPLETED",
        `${event.payload.model.provider}/${event.payload.model.model}`,
        { usage: publicUsage(event.payload.usage) },
      );
    case "llm.failed":
      return settleActive(
        state,
        "activeLlm",
        llmId(event),
        "FAILED",
        safeError(event.payload.error),
      );
    case "tool.requested":
      return upsertActive(state, "activeTools", {
        id: `tool:${event.payload.invocationId}`,
        kind: "TOOL",
        title: event.title ?? formatToolLabel(event.payload.toolName),
        text: bound(event.summary ?? `${formatToolLabel(event.payload.toolName)} requested`, state),
        status: "REQUESTED",
        toolName: event.payload.toolName,
        invocationId: event.payload.invocationId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      });
    case "tool.started":
      return updateActive(state, "activeTools", `tool:${event.payload.invocationId}`, (entry) => ({
        ...entry,
        status: "RUNNING",
      }));
    case "tool.completed":
      return settleActive(
        state,
        "activeTools",
        `tool:${event.payload.invocationId}`,
        "COMPLETED",
        "Tool completed",
      );
    case "tool.failed":
      return settleActive(
        state,
        "activeTools",
        `tool:${event.payload.invocationId}`,
        "FAILED",
        safeError(event.payload.error),
      );
    case "tool.output":
    case "shell.output":
    case "process.output":
      return state;
    case "shell.started":
      return updateActive(state, "activeTools", `tool:${event.payload.invocationId}`, (entry) => ({
        ...entry,
        title: "Run command",
        text: "Run command",
      }));
    case "shell.completed":
      return settleActive(
        state,
        "activeTools",
        `tool:${event.payload.invocationId}`,
        "COMPLETED",
        event.payload.exitCode === undefined
          ? `Command completed by signal ${event.payload.signal ?? "unknown"}.`
          : `Command exited with code ${event.payload.exitCode}.`,
      );
    case "file.read":
      return reduceFile(state, event, formatFileRead(event.payload.path));
    case "file.created":
    case "file.modified":
    case "file.deleted":
      return reduceFile(
        state,
        event,
        formatFileChange(event.payload.summary.path, event.payload.summary.changeType),
      );
    case "file.moved":
      return reduceFile(state, event, formatFileMove(event.payload.fromPath, event.payload.toPath));
    case "process.started":
      return upsertActive(state, "activeProcesses", {
        id: `process:${event.payload.process.id}`,
        kind: "PROCESS",
        title: "Process",
        text: bound(
          `${sanitizeTerminalText(event.payload.process.command)} · ${event.payload.process.status.toLowerCase()}`,
          state,
        ),
        status: "RUNNING",
        processId: event.payload.process.id,
      });
    case "process.stopped":
      return settleActive(
        state,
        "activeProcesses",
        `process:${event.payload.processId}`,
        "COMPLETED",
        `Process ${event.payload.status.toLowerCase()}.`,
      );
    case "retry.scheduled":
      return upsertRetry(state, event, "PENDING");
    case "retry.started":
      return upsertRetry(state, event, "RUNNING");
    case "verification.planned":
      return upsertVerification(state, {
        id: event.payload.planId,
        label: "Verification",
        status: "PENDING",
        checks: [],
        checkCount: event.payload.checkCount,
        plannedCounts: { ...event.payload.counts },
      });
    case "verification.check.started":
      return updateVerificationCheck(state, event, "RUNNING");
    case "verification.check.completed":
      return updateVerificationCheck(
        state,
        event,
        event.payload.status === "PASSED"
          ? "PASSED"
          : event.payload.status === "FAILED"
            ? "FAILED"
            : event.payload.status === "ERROR"
              ? "ERROR"
              : "SKIPPED",
        event.payload.durationMs,
      );
    case "verification.repair.started":
      return appendSettled(state, {
        id: event.eventId,
        kind: "VERIFICATION",
        title: "Verification repair",
        text: `Repair cycle ${event.payload.repairCycle}`,
        status: "RUNNING",
      });
    case "verification.repair.limit_reached":
      return appendSettled(state, {
        id: event.eventId,
        kind: "VERIFICATION",
        title: "Verification repair",
        text: "Repair limit reached.",
        status: "FAILED",
      });
    case "verification.finalized": {
      const group = state.verification.find((item) => item.id === event.payload.planId);
      return appendSettled(
        {
          ...state,
          verification: state.verification.filter((group) => group.id !== event.payload.planId),
        },
        {
          id: event.eventId,
          kind: "VERIFICATION",
          title: "Verification",
          text: `Verification ${event.payload.outcome.toLowerCase()}.`,
          status: "FINALIZED",
          planId: event.payload.planId,
          counts: {
            total: group?.checkCount ?? 0,
            failed: event.payload.failedCheckIds.length,
            error: event.payload.errorCheckIds.length,
          },
        },
      );
    }
    case "verification.started":
      return upsertVerification(state, {
        id: event.eventId,
        label: "Verification",
        status: "RUNNING",
        checks: [],
      });
    case "verification.completed":
      return appendSettled(state, {
        id: event.eventId,
        kind: "VERIFICATION",
        title: "Verification",
        text: "Verification completed.",
        status: "FINALIZED",
      });
    case "approval.requested":
      return upsertActive(state, "activeApprovals", {
        id: `approval:${event.payload.approval.id}`,
        kind: "APPROVAL",
        title: event.payload.approval.title,
        text: bound(event.payload.approval.reason, state),
        status: "PENDING",
        invocationId: event.payload.approval.toolInvocationId,
        riskLevel: event.payload.approval.riskLevel,
        scope: event.payload.approval.scope,
      });
    case "approval.resolved":
      return settleActive(
        state,
        "activeApprovals",
        `approval:${event.payload.approvalId}`,
        "RESOLVED",
        `Approval ${event.payload.status.toLowerCase()}.`,
      );
    case "error":
      return appendSettled(state, {
        id: event.eventId,
        kind: "SYSTEM",
        title: "Error",
        text: safeError(event.payload.error),
        status: "FAILED",
      });
    case "budget.exceeded":
      return appendSettled(state, {
        id: event.eventId,
        kind: "SYSTEM",
        title: "Budget exceeded",
        text: `Budget exceeded: ${event.payload.dimension}.`,
        status: "FAILED",
      });
    case "plan.updated":
      return {
        ...state,
        currentPlan: event.payload.plan.slice(0, state.limits.maxActiveEntries).map((item) => ({
          id: item.id,
          kind: "SYSTEM",
          title: item.title,
          text: item.status,
          status: "PENDING",
        })),
      };
    default:
      return state;
  }
}

function registerEvent(
  state: TimelineState,
  event: AgentEvent,
): { kind: "NEW"; state: TimelineState } | { kind: "DUPLICATE" | "CONFLICT" } {
  const sequence = event.durability.kind === "DURABLE" ? event.durability.sequence : undefined;
  const known = state.seenEvents.find((seen) => seen.eventId === event.eventId);
  if (known !== undefined)
    return known.sequence === sequence ? { kind: "DUPLICATE" } : { kind: "CONFLICT" };
  if (
    sequence !== undefined &&
    (sequence <= state.lastDurableSequence ||
      state.seenEvents.some((seen) => seen.sequence === sequence))
  )
    return { kind: "CONFLICT" };
  return {
    kind: "NEW",
    state: {
      ...state,
      seenEvents: [
        ...state.seenEvents,
        { eventId: event.eventId, ...(sequence === undefined ? {} : { sequence }) },
      ].slice(-state.limits.maxSeenEvents),
      ...(sequence === undefined ? {} : { lastDurableSequence: sequence }),
    },
  };
}

function reduceReasoning(
  state: TimelineState,
  event: Extract<AgentEvent, { type: "reasoning.summary" }>,
): TimelineState {
  const text = bound(event.payload.summary, state);
  if (state.settled.at(-1)?.kind === "REASONING" && state.settled.at(-1)?.text === text)
    return state;
  return appendSettled(state, {
    id: event.eventId,
    kind: "REASONING",
    title: "Thinking",
    text,
    status: "COMPLETED",
  });
}
function llmId(
  event: Extract<AgentEvent, { type: "llm.started" | "llm.completed" | "llm.failed" }>,
): string {
  return `llm:${event.stepId ?? "run"}:${event.payload.model.provider}:${event.payload.model.model}`;
}
function reduceFile(state: TimelineState, event: AgentEvent, text: string): TimelineState {
  const candidates = state.activeTools.filter((entry) => entry.stepId === event.stepId);
  if (candidates.length === 1)
    return updateActive(state, "activeTools", candidates[0]!.id, (entry) => ({
      ...entry,
      detail: bound(text, state),
    }));
  return appendSettled(state, {
    id: event.eventId,
    kind: "FILE",
    title: "File activity",
    text: bound(text, state),
    status: "COMPLETED",
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
  });
}
function upsertActive(
  state: TimelineState,
  field: "activeTools" | "activeLlm" | "activeApprovals" | "activeProcesses",
  entry: TimelineEntry,
): TimelineState {
  return { ...state, [field]: upsert(state[field], entry, state.limits.maxActiveEntries) };
}
function updateActive(
  state: TimelineState,
  field: "activeTools" | "activeLlm" | "activeApprovals" | "activeProcesses",
  id: string,
  update: (entry: TimelineEntry) => TimelineEntry,
): TimelineState {
  const entry = state[field].find((item) => item.id === id);
  return entry === undefined ? state : upsertActive(state, field, update(entry));
}
function settleActive(
  state: TimelineState,
  field: "activeTools" | "activeLlm" | "activeApprovals" | "activeProcesses",
  id: string,
  status: TimelineEntryStatus,
  fallback: string,
  extra: Partial<TimelineEntry> = {},
): TimelineState {
  const entry = state[field].find((item) => item.id === id);
  const next = { ...state, [field]: state[field].filter((item) => item.id !== id) };
  return appendSettled(next, {
    ...(entry ?? {
      id,
      kind:
        field === "activeLlm"
          ? "LLM"
          : field === "activeProcesses"
            ? "PROCESS"
            : field === "activeApprovals"
              ? "APPROVAL"
              : "TOOL",
      title: "Activity",
    }),
    ...extra,
    status,
    text: bound(fallback, state),
  });
}
function upsertRetry(
  state: TimelineState,
  event: Extract<AgentEvent, { type: "retry.scheduled" | "retry.started" }>,
  status: TimelineEntryStatus,
): TimelineState {
  const id = `${event.stepId ?? "run"}:${event.payload.attempt}`;
  const retry: TimelineRetry = {
    id,
    attempt: event.payload.attempt,
    status,
    ...("errorCode" in event.payload ? { reason: event.payload.errorCode } : {}),
  };
  return { ...state, retries: upsert(state.retries, retry, state.limits.maxActiveEntries) };
}
function upsertVerification(state: TimelineState, group: TimelineVerificationGroup): TimelineState {
  return {
    ...state,
    verification: upsert(state.verification, group, state.limits.maxActiveEntries),
  };
}
function updateVerificationCheck(
  state: TimelineState,
  event: Extract<
    AgentEvent,
    { type: "verification.check.started" | "verification.check.completed" }
  >,
  status: TimelineEntryStatus,
  durationMs?: number,
): TimelineState {
  const group = state.verification.find((item) => item.id === event.payload.planId) ?? {
    id: event.payload.planId,
    label: "Verification",
    status: "RUNNING" as const,
    checks: [],
  };
  const existing = group.checks.find((item) => item.id === event.payload.checkId);
  const check: TimelineVerificationCheck = {
    id: event.payload.checkId,
    label:
      event.type === "verification.check.started"
        ? `${event.payload.kind} · ${event.payload.purpose} · ${event.payload.stage}`
        : (existing?.label ?? "Check"),
    status,
    ...(durationMs === undefined ? {} : { detail: `${durationMs}ms` }),
  };
  return upsertVerification(state, {
    ...group,
    status: "RUNNING",
    checks: upsert(group.checks, check, state.limits.maxActiveEntries),
  });
}
function appendSettled(state: TimelineState, entry: TimelineEntry): TimelineState {
  let settled = [
    ...state.settled,
    { ...entry, ...(entry.text === undefined ? {} : { text: bound(entry.text, state) }) },
  ];
  let omittedActivity = state.omittedActivity;
  if (settled.length > state.limits.maxSettledEntries) {
    const room = state.limits.maxSettledEntries - 1;
    settled = [
      {
        id: "timeline:omitted",
        kind: "SYSTEM",
        title: "Timeline",
        text: OMITTED_MARKER,
        status: "SKIPPED",
      },
      ...(room === 0 ? [] : settled.slice(-room)),
    ];
    omittedActivity = true;
  }
  return { ...state, settled, omittedActivity };
}
function upsert<T extends { readonly id: string }>(
  items: readonly T[],
  value: T,
  limit: number,
): readonly T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [...items, value].slice(-limit);
  const copy = [...items];
  copy[index] = value;
  return copy;
}
function bound(value: string, state: TimelineState): string {
  return truncateTimelineText(sanitizeTerminalText(value), state.limits.maxTextBytes);
}
function safeError(error: { readonly code: string; readonly phase?: string | undefined }): string {
  return error.phase === undefined
    ? `Error: ${error.code}`
    : `Error: ${error.code} (${error.phase})`;
}
function publicUsage(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
  readonly toolCalls: number;
}): Readonly<{ inputTokens: number; outputTokens: number; steps: number; toolCalls: number }> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    steps: usage.steps,
    toolCalls: usage.toolCalls,
  };
}
