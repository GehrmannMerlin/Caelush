import type { AgentEvent, PlanItem, ProcessStatus, ToolInvocationId } from "@caelush/protocol";
import {
  type CliTimelineEntry,
  type CliTimelineState,
  type CliTimelineVerificationCheck,
  type CliTimelineVerificationGroup,
  type CliTimelineRetry,
  processStatusLabel,
  runStatusLabel,
} from "./timeline-model.js";
import {
  formatFileChange,
  formatFileRead,
  formatFileMove,
  formatToolLabel,
  sanitizeTerminalText,
  truncateTimelineText,
} from "./timeline-presentation.js";

export { createInitialCliTimelineState } from "./timeline-model.js";

const ADDITIONAL_ACTIVITY_MARKER = "… additional activity omitted …";

export function reduceTimelineEvent(state: CliTimelineState, event: AgentEvent): CliTimelineState {
  if (state.error !== undefined) return state;
  if (state.runId !== undefined && state.runId !== event.runId) return state;
  if (event.visibility !== "USER_VISIBLE") return state;

  const registration = registerEvent(state, event);
  if (registration.kind === "DUPLICATE") return state;
  if (registration.kind === "CONFLICT") {
    return { ...state, error: "Timeline event order could not be verified." };
  }
  const base = registration.state;

  switch (event.type) {
    case "tool.requested":
      return reduceToolRequested(base, event);
    case "tool.started":
      return reduceToolStarted(base, event.payload.invocationId);
    case "tool.output":
      return reduceToolOutput(base, event.payload.invocationId, event.payload.chunk);
    case "tool.completed":
      return reduceToolSettled(base, event.payload.invocationId, "COMPLETED", "Tool completed");
    case "tool.failed":
      return reduceToolSettled(
        base,
        event.payload.invocationId,
        "FAILED",
        safeErrorText(event.payload.error.code, event.payload.error.phase),
      );
    case "shell.started":
      return reduceShellStarted(base, event.payload.invocationId, event.payload.command);
    case "shell.output":
      return reduceToolOutput(base, event.payload.invocationId, event.payload.chunk);
    case "shell.completed":
      return reduceShellCompleted(base, event.payload.invocationId, event.payload);
    case "file.read":
      return reduceFileEvent(base, event, formatFileRead(event.payload.path));
    case "file.created":
    case "file.modified":
    case "file.deleted":
      return reduceFileEvent(base, event, formatFileChange(event.payload.summary));
    case "file.moved":
      return reduceFileEvent(
        base,
        event,
        formatFileMove(event.payload.fromPath, event.payload.toPath),
      );
    case "process.started":
      return reduceProcessStarted(base, event.payload.process);
    case "process.output":
      return reduceProcessOutput(base, event.payload.processId, event.payload.chunk);
    case "process.stopped":
      return reduceProcessStopped(base, event.payload.processId, event.payload.status);
    case "reasoning.summary":
      return reduceReasoning(base, event.payload.summary);
    case "plan.updated":
      return {
        ...base,
        currentPlan: copyPlan(event.payload.plan).slice(0, base.limits.maxActiveEntries),
      };
    case "retry.scheduled":
      return reduceRetryScheduled(base, event);
    case "retry.started":
      return reduceRetryStarted(base, event);
    case "verification.planned":
      return reduceVerificationPlanned(base, event);
    case "verification.check.started":
      return reduceVerificationCheckStarted(base, event);
    case "verification.check.completed":
      return reduceVerificationCheckCompleted(base, event);
    case "verification.repair.started":
      return appendSettled(base, {
        id: event.eventId,
        kind: "VERIFICATION",
        title: "Verification repair",
        text: `↻ Repair cycle ${event.payload.repairCycle}`,
        status: "RUNNING",
        runId: event.runId,
        stepId: event.stepId,
        planId: event.payload.failedPlanId,
      });
    case "verification.repair.limit_reached":
      return appendSettled(base, {
        id: event.eventId,
        kind: "VERIFICATION",
        title: "Verification repair",
        text: `Repair limit reached (${event.payload.attemptedRepairs}/${event.payload.maxAutoRepairs})`,
        status: "FAILED",
        runId: event.runId,
        stepId: event.stepId,
        planId: event.payload.planId,
      });
    case "verification.finalized":
      return reduceVerificationFinalized(base, event);
    case "approval.requested":
      return reduceApprovalRequested(base, event);
    case "approval.resolved":
      return reduceApprovalResolved(base, event.payload.approvalId, event.payload.status);
    case "error":
      return appendSettled(base, {
        id: event.eventId,
        kind: "ERROR",
        title: "Error",
        text: safeErrorText(event.payload.error.code, event.payload.error.phase),
        status: "FAILED",
        runId: event.runId,
        stepId: event.stepId,
      });
    case "budget.exceeded":
      return appendSettled(base, {
        id: event.eventId,
        kind: "BUDGET",
        title: "Budget exceeded",
        text: `Budget exceeded: ${event.payload.dimension}`,
        status: "FAILED",
        runId: event.runId,
        stepId: event.stepId,
      });
    default:
      return base;
  }
}

export function flushTimelineForTerminal(
  state: CliTimelineState,
  status:
    "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED" | "BUDGET_EXCEEDED",
): CliTimelineState {
  void status;
  let next = state;
  for (const tool of state.activeTools) {
    next = appendSettled(next, {
      ...tool,
      status: "INTERRUPTED",
      text: `${tool.title} · Interrupted by Run termination`,
    });
  }
  for (const process of state.activeProcesses) {
    next = appendSettled(next, {
      ...process,
      text: "Process remains active in daemon.",
    });
  }
  for (const approval of state.activeApprovals) {
    next = appendSettled(next, {
      ...approval,
      status: "INTERRUPTED",
      text: `${approval.text} · Run terminated before resolution`,
    });
  }
  for (const retry of state.retries) {
    next = appendSettled(next, {
      id: `retry:${retry.id}`,
      kind: "RETRY",
      title: "Retry",
      text: `${retry.text} · Run terminated`,
      status: "INTERRUPTED",
      runId: state.runId,
    });
  }
  for (const group of state.verification) {
    next = appendSettled(next, {
      id: `verification:${group.planId}`,
      kind: "VERIFICATION",
      title: "Verification",
      text: "Verification interrupted by Run termination.",
      status: "INTERRUPTED",
      runId: state.runId,
      planId: group.planId,
    });
  }
  const flushed = {
    ...next,
    activeTools: [],
    activeProcesses: [],
    activeApprovals: [],
    verification: [],
    retries: [],
  };
  delete flushed.currentPlan;
  return flushed;
}

interface RegisteredEventState {
  readonly kind: "NEW";
  readonly state: CliTimelineState;
}

interface DuplicateEventState {
  readonly kind: "DUPLICATE";
}

interface ConflictEventState {
  readonly kind: "CONFLICT";
}

function registerEvent(
  state: CliTimelineState,
  event: AgentEvent,
): RegisteredEventState | DuplicateEventState | ConflictEventState {
  const sequence = event.durability.kind === "DURABLE" ? event.durability.sequence : undefined;
  const known = state.seenEvents.find((entry) => entry.eventId === event.eventId);
  if (known !== undefined) {
    return known.sequence === sequence ? { kind: "DUPLICATE" } : { kind: "CONFLICT" };
  }
  if (
    sequence !== undefined &&
    (sequence <= state.lastDurableSequence ||
      state.seenEvents.some((entry) => entry.sequence === sequence))
  ) {
    return { kind: "CONFLICT" };
  }
  const seenEvents = [
    ...state.seenEvents,
    { eventId: event.eventId, ...(sequence === undefined ? {} : { sequence }) },
  ].slice(-state.limits.maxSeenEvents);
  return {
    kind: "NEW",
    state: {
      ...state,
      seenEvents,
      ...(sequence === undefined ? {} : { lastDurableSequence: sequence }),
    },
  };
}

function reduceToolRequested(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "tool.requested" }>,
): CliTimelineState {
  const entry: CliTimelineEntry = {
    id: `tool:${event.payload.invocationId}`,
    kind: "TOOL",
    title: event.title ?? formatToolLabel(event.payload.toolName),
    text: boundText(event.summary ?? `${formatToolLabel(event.payload.toolName)} requested`, state),
    status: "REQUESTED",
    runId: event.runId,
    stepId: event.stepId,
    invocationId: event.payload.invocationId,
  };
  const activeTools = upsertById(state.activeTools, entry, state.limits.maxActiveEntries);
  return { ...state, activeTools };
}

function reduceToolStarted(state: CliTimelineState, invocationId: string): CliTimelineState {
  return updateActiveTool(state, invocationId, (entry) => ({ ...entry, status: "RUNNING" }));
}

function reduceToolOutput(
  state: CliTimelineState,
  invocationId: string,
  chunk: string,
): CliTimelineState {
  const update = (entry: CliTimelineEntry): CliTimelineEntry => ({
    ...entry,
    text: boundText(`${entry.text}\n${chunk}`, state),
  });
  const active = updateActiveTool(state, invocationId, update);
  if (active.activeTools.some((entry) => entry.invocationId === invocationId)) return active;
  const settledIndex = active.settled.findIndex((entry) => entry.invocationId === invocationId);
  if (settledIndex < 0) {
    return appendSettled(active, {
      id: `tool-output:${invocationId}`,
      kind: "TOOL",
      title: "Tool output",
      text: boundText(chunk, active),
      runId: active.runId,
      invocationId: invocationId as ToolInvocationId,
    });
  }
  const settled = [...active.settled];
  settled[settledIndex] = update(settled[settledIndex]!);
  return { ...active, settled };
}

function reduceToolSettled(
  state: CliTimelineState,
  invocationId: string,
  status: "COMPLETED" | "FAILED",
  fallbackText: string,
): CliTimelineState {
  const index = state.activeTools.findIndex((entry) => entry.invocationId === invocationId);
  if (index < 0) {
    return appendSettled(state, {
      id: `tool-terminal:${invocationId}`,
      kind: "TOOL",
      title: status === "FAILED" ? "Tool failed" : "Tool completed",
      text: fallbackText,
      status,
      runId: state.runId,
      invocationId: invocationId as ToolInvocationId,
    });
  }
  const entry = state.activeTools[index]!;
  const activeTools = state.activeTools.filter((_, itemIndex) => itemIndex !== index);
  return appendSettled(
    { ...state, activeTools },
    { ...entry, status, text: entry.text || fallbackText },
  );
}

function reduceShellStarted(
  state: CliTimelineState,
  invocationId: string,
  command: string,
): CliTimelineState {
  const shellText = command.length > 0 ? `Command: ${command}` : "Run command";
  return updateActiveTool(state, invocationId, (entry) => ({
    ...entry,
    title: "Run command",
    text: boundText(shellText, state),
  }));
}

function reduceShellCompleted(
  state: CliTimelineState,
  invocationId: string,
  payload: Extract<AgentEvent, { type: "shell.completed" }>["payload"],
): CliTimelineState {
  const result =
    payload.exitCode === undefined
      ? `Command completed by signal ${payload.signal ?? "unknown"}.`
      : `Command exited with code ${payload.exitCode}.`;
  return reduceToolSettled(state, invocationId, "COMPLETED", result);
}

function reduceFileEvent(
  state: CliTimelineState,
  event: AgentEvent,
  text: string,
): CliTimelineState {
  const candidateTools = state.activeTools.filter((entry) => entry.stepId === event.stepId);
  if (candidateTools.length === 1) {
    const target = candidateTools[0]!;
    return updateActiveTool(state, target.invocationId!, (entry) => ({
      ...entry,
      text: boundText(`${entry.text}\n${text}`, state),
    }));
  }
  return appendSettled(state, {
    id: event.eventId,
    kind: "FILE",
    title: "File change",
    text: boundText(text, state),
    runId: event.runId,
    stepId: event.stepId,
  });
}

function reduceProcessStarted(
  state: CliTimelineState,
  process: { readonly id: string; readonly command: string; readonly status: ProcessStatus },
): CliTimelineState {
  const entry: CliTimelineEntry = {
    id: `process:${process.id}`,
    kind: "PROCESS",
    title: "Process",
    text: boundText(
      `${sanitizeTerminalText(process.command)} · ${processStatusLabel(process.status)}`,
      state,
    ),
    status: "RUNNING",
    runId: state.runId,
    processId: process.id,
  };
  return {
    ...state,
    activeProcesses: upsertById(state.activeProcesses, entry, state.limits.maxActiveEntries),
  };
}

function reduceProcessOutput(
  state: CliTimelineState,
  processId: string,
  chunk: string,
): CliTimelineState {
  const index = state.activeProcesses.findIndex((entry) => entry.processId === processId);
  if (index < 0) return state;
  const activeProcesses = [...state.activeProcesses];
  activeProcesses[index] = {
    ...activeProcesses[index]!,
    text: boundText(`${activeProcesses[index]!.text}\n${chunk}`, state),
  };
  return { ...state, activeProcesses };
}

function reduceProcessStopped(
  state: CliTimelineState,
  processId: string,
  status: ProcessStatus,
): CliTimelineState {
  const entry = state.activeProcesses.find((item) => item.processId === processId);
  const activeProcesses = state.activeProcesses.filter((item) => item.processId !== processId);
  return appendSettled(
    { ...state, activeProcesses },
    entry ?? {
      id: `process-stopped:${processId}`,
      kind: "PROCESS",
      title: "Process",
      text: `Process ${processStatusLabel(status)}.`,
      status: "COMPLETED",
      runId: state.runId,
      processId,
    },
  );
}

function reduceReasoning(state: CliTimelineState, summary: string): CliTimelineState {
  const text = boundText(summary, state);
  if (state.settled.at(-1)?.kind === "REASONING" && state.settled.at(-1)?.text === text)
    return state;
  return appendSettled(state, {
    id: `reasoning:${state.lastDurableSequence}`,
    kind: "REASONING",
    title: "Thinking",
    text,
    runId: state.runId,
  });
}

function reduceRetryScheduled(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "retry.scheduled" }>,
): CliTimelineState {
  const id = `${event.stepId ?? "run"}:${event.payload.attempt}`;
  const retry: CliTimelineRetry = {
    id,
    attempt: event.payload.attempt,
    maxAttempts: event.payload.maxAttempts,
    text: `↻ Retry ${event.payload.attempt}/${event.payload.maxAttempts} in ${event.payload.delayMs}ms ${event.payload.errorCode}`,
    started: false,
  };
  return { ...state, retries: upsertById(state.retries, retry, state.limits.maxActiveEntries) };
}

function reduceRetryStarted(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "retry.started" }>,
): CliTimelineState {
  const id = `${event.stepId ?? "run"}:${event.payload.attempt}`;
  const existing = state.retries.find((retry) => retry.id === id);
  const retry: CliTimelineRetry = {
    id,
    attempt: event.payload.attempt,
    maxAttempts: event.payload.maxAttempts,
    text: existing?.text ?? `↻ Retry ${event.payload.attempt}/${event.payload.maxAttempts}`,
    started: true,
  };
  return { ...state, retries: upsertById(state.retries, retry, state.limits.maxActiveEntries) };
}

function reduceVerificationPlanned(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "verification.planned" }>,
): CliTimelineState {
  const group: CliTimelineVerificationGroup = {
    planId: event.payload.planId,
    checkCount: event.payload.checkCount,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    finalized: false,
    checks: [],
  };
  return {
    ...state,
    verification: upsertByKey(
      state.verification,
      group,
      (item) => item.planId,
      state.limits.maxActiveEntries,
    ),
  };
}

function reduceVerificationCheckStarted(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "verification.check.started" }>,
): CliTimelineState {
  const current = state.verification.find((group) => group.planId === event.payload.planId);
  const group = current ?? emptyVerificationGroup(event.payload.planId, event.payload.ordinal + 1);
  const check: CliTimelineVerificationCheck = {
    checkId: event.payload.checkId,
    status: "RUNNING",
    title: `${event.payload.kind} · ${event.payload.purpose}`,
  };
  const nextGroup = {
    ...group,
    checks: upsertByKey(group.checks, check, (item) => item.checkId, 32),
  };
  return {
    ...state,
    verification: upsertByKey(
      state.verification,
      nextGroup,
      (item) => item.planId,
      state.limits.maxActiveEntries,
    ),
  };
}

function reduceVerificationCheckCompleted(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "verification.check.completed" }>,
): CliTimelineState {
  const current = state.verification.find((group) => group.planId === event.payload.planId);
  const group = current ?? emptyVerificationGroup(event.payload.planId, 0);
  const previous = group.checks.find((check) => check.checkId === event.payload.checkId)?.status;
  const counts = decrementVerificationCount(group, previous);
  const check: CliTimelineVerificationCheck = {
    checkId: event.payload.checkId,
    status: event.payload.status,
    title: `Check ${event.payload.status}`,
  };
  const nextGroup = {
    ...counts,
    ...incrementVerificationCount(counts, event.payload.status),
    checks: upsertByKey(counts.checks, check, (item) => item.checkId, 32),
  };
  return {
    ...state,
    verification: upsertByKey(
      state.verification,
      nextGroup,
      (item) => item.planId,
      state.limits.maxActiveEntries,
    ),
  };
}

function reduceVerificationFinalized(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "verification.finalized" }>,
): CliTimelineState {
  const group = state.verification.find((item) => item.planId === event.payload.planId);
  const verification: CliTimelineVerificationGroup = {
    ...(group ?? emptyVerificationGroup(event.payload.planId, 0)),
    finalized: true,
    outcome: event.payload.outcome,
  };
  const next = {
    ...state,
    verification: state.verification.filter((item) => item.planId !== event.payload.planId),
  };
  return appendSettled(next, {
    id: event.eventId,
    kind: "VERIFICATION",
    title: "Verification",
    text: `Verification ${event.payload.outcome.toLowerCase()}.`,
    status: "FINALIZED",
    runId: event.runId,
    stepId: event.stepId,
    planId: verification.planId,
  });
}

function reduceApprovalRequested(
  state: CliTimelineState,
  event: Extract<AgentEvent, { type: "approval.requested" }>,
): CliTimelineState {
  const approval = event.payload.approval;
  const entry: CliTimelineEntry = {
    id: `approval:${approval.id}`,
    kind: "APPROVAL",
    title: "Approval required",
    text: boundText(`${approval.title}: ${approval.reason}`, state),
    status: "PENDING",
    runId: event.runId,
    stepId: event.stepId,
    invocationId: approval.toolInvocationId,
  };
  return {
    ...state,
    activeApprovals: upsertById(state.activeApprovals, entry, state.limits.maxActiveEntries),
  };
}

function reduceApprovalResolved(
  state: CliTimelineState,
  approvalId: string,
  status: string,
): CliTimelineState {
  const id = `approval:${approvalId}`;
  const entry = state.activeApprovals.find((item) => item.id === id);
  const activeApprovals = state.activeApprovals.filter((item) => item.id !== id);
  return appendSettled(
    { ...state, activeApprovals },
    entry === undefined
      ? {
          id: `approval-resolved:${approvalId}`,
          kind: "APPROVAL",
          title: "Approval",
          text: `Approval ${status.toLowerCase()}.`,
          status: "RESOLVED",
          runId: state.runId,
        }
      : { ...entry, status: "RESOLVED", text: `${entry.text} · ${status.toLowerCase()}` },
  );
}

function updateActiveTool(
  state: CliTimelineState,
  invocationId: string,
  update: (entry: CliTimelineEntry) => CliTimelineEntry,
): CliTimelineState {
  const index = state.activeTools.findIndex((entry) => entry.invocationId === invocationId);
  if (index < 0) return state;
  const activeTools = [...state.activeTools];
  activeTools[index] = update(activeTools[index]!);
  return { ...state, activeTools };
}

function appendSettled(state: CliTimelineState, entry: CliTimelineEntry): CliTimelineState {
  const bounded = { ...entry, text: boundText(entry.text, state) };
  let settled = [...state.settled, bounded];
  let omittedActivity = state.omittedActivity;
  if (settled.length > state.limits.maxSettledEntries) {
    const preserved = settled.filter((item) => item.status === "FINALIZED");
    const candidates = settled.filter((item) => item.status !== "FINALIZED");
    const room = Math.max(0, state.limits.maxSettledEntries - preserved.length - 1);
    settled = [
      ...candidates.slice(-room),
      ...(omittedActivity
        ? []
        : [
            {
              id: "timeline:omitted",
              kind: "ERROR" as const,
              title: "Timeline",
              text: ADDITIONAL_ACTIVITY_MARKER,
            },
          ]),
      ...preserved,
    ];
    omittedActivity = true;
  }
  return { ...state, settled, omittedActivity };
}

function boundText(text: string, state: CliTimelineState): string {
  return truncateTimelineText(sanitizeTerminalText(text), state.limits.maxTextBytes);
}

function safeErrorText(code: string, phase: string | undefined): string {
  return phase === undefined ? `Error: ${code}` : `Error: ${code} (${phase})`;
}

function upsertById<T extends { readonly id: string }>(
  items: readonly T[],
  value: T,
  limit: number,
): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    const next = [...items];
    next[index] = value;
    return next;
  }
  return [...items, value].slice(-limit);
}

function upsertByKey<T>(
  items: readonly T[],
  value: T,
  keyOf: (item: T) => string,
  limit: number,
): T[] {
  const key = keyOf(value);
  const index = items.findIndex((item) => keyOf(item) === key);
  if (index >= 0) {
    const next = [...items];
    next[index] = value;
    return next;
  }
  return [...items, value].slice(-limit);
}

function copyPlan(plan: readonly PlanItem[]): readonly PlanItem[] {
  return plan.map((item) => ({ ...item }));
}

function emptyVerificationGroup(
  planId: CliTimelineVerificationGroup["planId"],
  checkCount: number,
): CliTimelineVerificationGroup {
  return {
    planId,
    checkCount,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    finalized: false,
    checks: [],
  };
}

function decrementVerificationCount(
  group: CliTimelineVerificationGroup,
  status: CliTimelineVerificationCheck["status"] | undefined,
): CliTimelineVerificationGroup {
  if (status === "PASSED") return { ...group, passed: Math.max(0, group.passed - 1) };
  if (status === "FAILED") return { ...group, failed: Math.max(0, group.failed - 1) };
  if (status === "ERROR") return { ...group, errors: Math.max(0, group.errors - 1) };
  if (status === "SKIPPED") return { ...group, skipped: Math.max(0, group.skipped - 1) };
  return group;
}

function incrementVerificationCount(
  group: CliTimelineVerificationGroup,
  status: CliTimelineVerificationCheck["status"],
): Partial<CliTimelineVerificationGroup> {
  if (status === "PASSED") return { passed: group.passed + 1 };
  if (status === "FAILED") return { failed: group.failed + 1 };
  if (status === "ERROR") return { errors: group.errors + 1 };
  if (status === "SKIPPED") return { skipped: group.skipped + 1 };
  return {};
}

export function formatRunTerminal(status: Parameters<typeof flushTimelineForTerminal>[1]): string {
  return `Run ended with status ${runStatusLabel(status)}.`;
}
