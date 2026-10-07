import {
  ToolPresentationEffectSchema,
  toolPresentationCategory,
  type AssistantMessagePhase,
  type PublicRunEvent,
  type RunId,
  type StepId,
  type ToolInvocationId,
  type ToolPresentationCategory,
  type ToolPresentationEffect,
  type ToolPresentationPhase,
} from "@caelush/protocol";
import {
  appendBoundedLiveText,
  createEmptyBoundedLiveText,
  type BoundedLiveText,
} from "./bounded-live-text.js";

export type LiveActivityKind =
  | "MODEL_TEXT"
  | "MODEL_REASONING"
  | "TOOL_PREPARATION"
  | "TOOL_ACTIVITY"
  | "TOOL_OUTPUT"
  | "SHELL_OUTPUT"
  | "PROCESS_OUTPUT";
export type LiveActivityStatus = "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface LiveActivity {
  readonly id: string;
  readonly kind: LiveActivityKind;
  readonly status: LiveActivityStatus;
  readonly text: string;
  /** Present on streamed text activities; retained bytes are maintained incrementally. */
  readonly retainedBytes?: number;
  readonly truncated?: boolean;
  readonly omittedBytes?: number;
  readonly streamKey: string;
  readonly streamSequence: number;
  readonly runId: RunId;
  /** Bound by the Web presentation seam from the owning V3 Turn, never synthesized here. */
  readonly conversationTurnId?: string;
  readonly assistantItemId?: string;
  readonly phase?: AssistantMessagePhase;
  readonly settledAtSequence?: number;
  readonly stepId?: string;
  readonly invocationId?: string;
  readonly toolInvocationId?: ToolInvocationId;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly category?: ToolPresentationCategory;
  readonly toolPhase?: ToolPresentationPhase;
  readonly title?: string;
  readonly approvalId?: string;
  readonly processId?: string;
  readonly effects?: readonly ToolPresentationEffect[];
  readonly effectEventIds?: readonly string[];
}

export interface LiveActivityState {
  readonly runId?: RunId;
  readonly activities: readonly LiveActivity[];
  readonly modelWait?: ModelWaitState;
  readonly settledModelStepIds: readonly StepId[];
  readonly seenEventIds: readonly string[];
  readonly lastStreamSequences: Readonly<Record<string, number>>;
  readonly lastDurableSequence: number;
  readonly terminal: boolean;
  readonly maxActivities: number;
  readonly maxTextBytes: number;
  readonly maxSeenEventIds: number;
}

export type ModelWaitPhase =
  | "WAITING_PROVIDER"
  | "RECEIVING_PROVIDER_DATA"
  | "NO_RECENT_ACTIVITY"
  | "CANCELLING_IDLE_STREAM"
  | "ATTEMPT_FAILED"
  | "RETRY_SCHEDULED"
  | "RETRYING"
  | "FALLBACK_SELECTED"
  | "RETRY_EXHAUSTED";

/**
 * Bounded, public Provider progress for the active Run. It records application-level Provider
 * activity only; it deliberately has no browser or transport-health assertion.
 */
export interface ModelWaitState {
  readonly runId: RunId;
  readonly stepId?: StepId;
  readonly phase: ModelWaitPhase;
  readonly lastActivityAt: number;
  readonly idleForMs: number;
  readonly providerEventReceived: boolean;
  readonly displayableEventReceived: boolean;
  readonly idleTimeoutMs?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryOrdinal?: number;
  readonly maxRetries?: number;
  readonly delayMs?: number;
  readonly nextAttemptAt?: number;
  readonly errorCode?: string;
  readonly exhaustionReason?: string;
  readonly fromTransportId?: string;
  readonly toTransportId?: string;
}

type OrderedLiveEvent = PublicRunEvent & {
  readonly durability: {
    readonly kind: "EPHEMERAL";
    readonly version: 1;
    readonly deliveryClass: "ORDERED";
    readonly streamKey: string;
    readonly streamSequence: number;
  };
};
type CoalescibleLiveEvent = PublicRunEvent & {
  readonly durability: {
    readonly kind: "EPHEMERAL";
    readonly version: 1;
    readonly deliveryClass: "COALESCIBLE";
    readonly streamKey: string;
  };
};
type TransientLiveEvent = OrderedLiveEvent | CoalescibleLiveEvent;
type DurableLiveEvent = PublicRunEvent & {
  readonly durability: { readonly kind: "DURABLE"; readonly version: 1; readonly sequence: number };
};

export function createInitialLiveActivityState(runId?: RunId): LiveActivityState {
  return {
    ...(runId === undefined ? {} : { runId }),
    activities: [],
    settledModelStepIds: [],
    seenEventIds: [],
    lastStreamSequences: {},
    lastDurableSequence: 0,
    terminal: false,
    maxActivities: 64,
    maxTextBytes: 16 * 1024,
    maxSeenEventIds: 1024,
  };
}

/**
 * Project public SSE events into bounded live UI state.
 *
 * Transient signals are intentionally kept out of the durable Timeline reducer. Durable lifecycle
 * facts settle matching live entries, and a terminal Run fact settles anything still active after a
 * reconnect or a transient gap.
 */
export function reduceLiveActivityEvent(
  state: LiveActivityState,
  event: PublicRunEvent,
): LiveActivityState {
  if (state.runId !== undefined && state.runId !== event.runId) return state;
  if (state.seenEventIds.includes(event.eventId)) return state;

  if (isTransientLiveEvent(event)) {
    if (state.terminal) return state;
    if (
      isModelStreamEvent(event) &&
      event.stepId !== undefined &&
      state.settledModelStepIds.includes(event.stepId)
    ) {
      return remember(state, event.eventId);
    }
    if (
      event.durability.deliveryClass === "ORDERED" &&
      event.durability.streamSequence <=
        (state.lastStreamSequences[event.durability.streamKey] ?? 0)
    ) {
      return state;
    }
    const activity = activityFromTransient(event);
    if (activity === null) {
      const remembered = remember(state, event.eventId);
      return withModelWait(remembered, updateModelWaitFromTransient(state, event));
    }
    const existing = state.activities.find((item) => item.id === activity.id);
    const previousText =
      existing === undefined
        ? createEmptyBoundedLiveText()
        : boundedTextStateFor(existing, state.maxTextBytes);
    const boundedText = appendBoundedLiveText(previousText, activity.text, state.maxTextBytes);
    const nextActivity: LiveActivity = {
      ...activity,
      ...boundedText,
      ...(existing === undefined
        ? {}
        : {
            status: existing.status === "ACTIVE" ? activity.status : existing.status,
            ...(existing.settledAtSequence === undefined
              ? {}
              : { settledAtSequence: existing.settledAtSequence }),
          }),
    };
    const activities = [
      ...state.activities.filter((item) => item.id !== activity.id),
      nextActivity,
    ].slice(-state.maxActivities);
    const next = {
      ...remember(state, event.eventId),
      activities,
      lastStreamSequences:
        event.durability.deliveryClass === "ORDERED"
          ? {
              ...state.lastStreamSequences,
              [event.durability.streamKey]: event.durability.streamSequence,
            }
          : state.lastStreamSequences,
    };
    return withModelWait(next, updateModelWaitFromTransient(state, event));
  }

  if (!isDurableLiveEvent(event)) return remember(state, event.eventId);
  const sequence = event.durability.sequence;
  if (sequence <= state.lastDurableSequence) return state;
  const withToolLifecycle = projectToolLifecycleEvent(state.activities, event);
  const settled = settleForDurableEvent(withToolLifecycle, event);
  const next = {
    ...remember(state, event.eventId),
    activities: settled.activities,
    lastDurableSequence: sequence,
    terminal: settled.terminal || state.terminal,
  };
  return reduceModelWaitFromDurable(next, event, settled.terminal);
}

function projectToolLifecycleEvent(
  activities: readonly LiveActivity[],
  event: DurableLiveEvent,
): readonly LiveActivity[] {
  switch (event.type) {
    case "tool.requested":
      return upsertToolActivity(
        event.payload.externalCallId === undefined
          ? activities
          : activities.filter(
              (activity) =>
                !(
                  activity.kind === "TOOL_PREPARATION" &&
                  activity.runId === event.runId &&
                  activity.toolCallId === event.payload.externalCallId &&
                  (event.stepId === undefined || activity.stepId === event.stepId)
                ),
            ),
        {
          id: `tool-activity:${event.payload.invocationId}`,
          kind: "TOOL_ACTIVITY",
          toolInvocationId: event.payload.invocationId,
          toolName: event.payload.toolName,
          category: toolPresentationCategory(event.payload.toolName),
          toolPhase: "REQUESTED",
          title: event.title ?? toolTitle(event.payload.toolName),
          text: event.summary ?? "正在请求工具执行",
          status: "ACTIVE",
          streamKey: `durable:${event.runId}`,
          streamSequence: 0,
          runId: event.runId,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        },
      );
    case "llm.started":
      return activities.filter(
        (activity) =>
          activity.kind !== "TOOL_PREPARATION" ||
          activity.runId !== event.runId ||
          activity.stepId === event.stepId,
      );
    case "llm.failed":
      return event.stepId === undefined
        ? activities
        : activities.filter(
            (activity) =>
              !(
                activity.kind === "TOOL_PREPARATION" &&
                activity.runId === event.runId &&
                activity.stepId === event.stepId
              ),
          );
    case "tool.started": {
      const existing = activities.find(
        (activity) =>
          activity.kind === "TOOL_ACTIVITY" &&
          activity.toolInvocationId === event.payload.invocationId,
      );
      const toolName = event.payload.toolName ?? existing?.toolName;
      if (toolName === undefined) return activities;
      return upsertToolActivity(activities, {
        ...existing,
        id: `tool-activity:${event.payload.invocationId}`,
        kind: "TOOL_ACTIVITY",
        toolInvocationId: event.payload.invocationId,
        toolName,
        category: toolPresentationCategory(toolName),
        toolPhase: "RUNNING",
        title: event.title ?? existing?.title ?? toolTitle(toolName),
        text: event.summary ?? existing?.text ?? "工具正在运行",
        status: "ACTIVE",
        streamKey: existing?.streamKey ?? `durable:${event.runId}`,
        streamSequence: existing?.streamSequence ?? 0,
        runId: event.runId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      });
    }
    case "approval.requested": {
      const invocationId = event.payload.approval.toolInvocationId;
      return activities.map((activity) =>
        activity.kind === "TOOL_ACTIVITY" && activity.toolInvocationId === invocationId
          ? {
              ...activity,
              toolPhase: "WAITING_APPROVAL",
              approvalId: event.payload.approval.id,
              text: "等待批准后执行",
            }
          : activity,
      );
    }
    case "approval.resolved":
      return activities.map((activity) => {
        if (activity.kind !== "TOOL_ACTIVITY" || activity.approvalId !== event.payload.approvalId) {
          return activity;
        }
        const { approvalId: _approvalId, ...withoutApproval } = activity;
        void _approvalId;
        return {
          ...withoutApproval,
          ...(event.payload.status === "APPROVED" ? { toolPhase: "REQUESTED" as const } : {}),
        };
      });
    case "tool.completed":
      return settleToolActivity(activities, event.payload.invocationId, "COMPLETED", event);
    case "tool.failed":
      return settleToolActivity(
        activities,
        event.payload.invocationId,
        "FAILED",
        event,
        failedToolSummary(event),
      );
    case "file.created":
      return addToolFileEffect(activities, event, {
        type: "FILE_CHANGE",
        path: event.payload.summary.path,
        changeType: "CREATED",
        ...(event.payload.summary.additions === undefined
          ? {}
          : { additions: event.payload.summary.additions }),
        ...(event.payload.summary.deletions === undefined
          ? {}
          : { deletions: event.payload.summary.deletions }),
      });
    case "file.modified":
      return addToolFileEffect(activities, event, {
        type: "FILE_CHANGE",
        path: event.payload.summary.path,
        changeType: "MODIFIED",
        ...(event.payload.summary.additions === undefined
          ? {}
          : { additions: event.payload.summary.additions }),
        ...(event.payload.summary.deletions === undefined
          ? {}
          : { deletions: event.payload.summary.deletions }),
      });
    case "file.deleted":
      return addToolFileEffect(activities, event, {
        type: "FILE_CHANGE",
        path: event.payload.summary.path,
        changeType: "DELETED",
        ...(event.payload.summary.additions === undefined
          ? {}
          : { additions: event.payload.summary.additions }),
        ...(event.payload.summary.deletions === undefined
          ? {}
          : { deletions: event.payload.summary.deletions }),
      });
    case "file.moved":
      return addToolFileEffect(activities, event, {
        type: "FILE_CHANGE",
        path: event.payload.toPath,
        changeType: "MOVED",
        fromPath: event.payload.fromPath,
        ...(event.payload.additions === undefined ? {} : { additions: event.payload.additions }),
        ...(event.payload.deletions === undefined ? {} : { deletions: event.payload.deletions }),
      });
    default:
      return activities;
  }
}

function addToolFileEffect(
  activities: readonly LiveActivity[],
  event: Extract<
    DurableLiveEvent,
    { type: "file.created" | "file.modified" | "file.deleted" | "file.moved" }
  >,
  candidate: unknown,
): readonly LiveActivity[] {
  const invocationId = event.payload.invocationId;
  if (invocationId === undefined) return activities;
  const effect = ToolPresentationEffectSchema.safeParse(candidate);
  if (!effect.success) return activities;
  return activities.map((activity) => {
    if (
      activity.kind !== "TOOL_ACTIVITY" ||
      activity.runId !== event.runId ||
      activity.toolInvocationId !== invocationId ||
      activity.status !== "ACTIVE" ||
      activity.effectEventIds?.includes(event.eventId) === true
    ) {
      return activity;
    }
    return {
      ...activity,
      effects: [...(activity.effects ?? []), effect.data].slice(-128),
      effectEventIds: [...(activity.effectEventIds ?? []), event.eventId].slice(-128),
    };
  });
}

function upsertToolActivity(
  activities: readonly LiveActivity[],
  activity: LiveActivity,
): readonly LiveActivity[] {
  return [...activities.filter((item) => item.id !== activity.id), activity].slice(-64);
}

function settleToolActivity(
  activities: readonly LiveActivity[],
  invocationId: ToolInvocationId,
  phase: "COMPLETED" | "FAILED",
  event: DurableLiveEvent,
  text?: string,
): readonly LiveActivity[] {
  return activities.map((activity) =>
    activity.kind === "TOOL_ACTIVITY" && activity.toolInvocationId === invocationId
      ? {
          ...activity,
          status: phase,
          toolPhase: phase,
          text: text ?? event.summary ?? activity.text,
          settledAtSequence: event.durability.sequence,
        }
      : activity,
  );
}

function toolTitle(toolName: string): string {
  switch (toolPresentationCategory(toolName)) {
    case "READ":
      return "读取文件";
    case "SEARCH":
      return "搜索文件";
    case "EDIT":
      return "编辑文件";
    case "COMMAND":
      return "执行命令";
    case "PROCESS":
      return "进程操作";
    case "GIT":
      return "Git 操作";
    case "OTHER":
      return "使用工具";
  }
}

function toolPreparationText(toolName: string): string {
  let title: string;
  switch (toolPresentationCategory(toolName)) {
    case "READ":
      title = "读取文件";
      break;
    case "SEARCH":
      title =
        toolName === "list_directory"
          ? "浏览目录"
          : toolName === "search_text"
            ? "搜索内容"
            : "搜索文件";
      break;
    case "EDIT":
      title = "编辑文件";
      break;
    case "COMMAND":
      title = "执行命令";
      break;
    case "PROCESS":
      title = toolName === "stop_process" ? "停止进程" : "向进程输入";
      break;
    case "GIT":
      title = toolName === "git_status" ? "查看 Git 状态" : "查看 Git 修改";
      break;
    case "OTHER":
      return "正在准备调用工具";
  }
  return `正在准备${title}`;
}

function failedToolSummary(event: Extract<DurableLiveEvent, { type: "tool.failed" }>): string {
  return (
    event.summary ??
    (event.payload.error.code === "TOOL_OUTCOME_UNKNOWN"
      ? "工具结果未知，请勿自动重试"
      : "工具执行失败")
  );
}

const PROVIDER_WAIT_PHASES: ReadonlySet<ModelWaitPhase> = new Set([
  "WAITING_PROVIDER",
  "RECEIVING_PROVIDER_DATA",
  "NO_RECENT_ACTIVITY",
  "RETRYING",
]);

function updateModelWaitFromTransient(
  state: LiveActivityState,
  event: TransientLiveEvent,
): ModelWaitState | undefined {
  const current = state.modelWait;
  if (current === undefined || !PROVIDER_WAIT_PHASES.has(current.phase)) return current;
  if (event.stepId !== current.stepId) return current;
  if (event.type === "model.status") {
    return {
      ...current,
      phase: event.payload.phase,
      lastActivityAt: event.payload.lastActivityAt,
      idleForMs: event.payload.idleForMs,
      idleTimeoutMs: event.payload.idleTimeoutMs,
      providerEventReceived:
        current.providerEventReceived || event.payload.phase === "RECEIVING_PROVIDER_DATA",
    };
  }
  if (
    event.type === "model.text.delta" ||
    event.type === "model.reasoning_summary.delta" ||
    event.type === "model.tool_call.started"
  ) {
    return {
      ...current,
      phase: "RECEIVING_PROVIDER_DATA",
      lastActivityAt: event.timestamp,
      idleForMs: 0,
      providerEventReceived: true,
      displayableEventReceived: true,
    };
  }
  return current;
}

function reduceModelWaitFromDurable(
  state: LiveActivityState,
  event: DurableLiveEvent,
  terminal: boolean,
): LiveActivityState {
  if (terminal) return withModelWait(state, undefined);
  let modelWait = state.modelWait;
  let settledModelStepIds = state.settledModelStepIds;
  switch (event.type) {
    case "llm.started":
      if (event.stepId === undefined) break;
      settledModelStepIds = settledModelStepIds.filter((stepId) => stepId !== event.stepId);
      modelWait =
        modelWait?.runId === event.runId &&
        modelWait.stepId === event.stepId &&
        modelWait.phase === "RETRYING"
          ? {
              ...modelWait,
              lastActivityAt: event.timestamp,
              idleForMs: 0,
              providerEventReceived: false,
              displayableEventReceived: false,
            }
          : {
              runId: event.runId,
              stepId: event.stepId,
              phase: "WAITING_PROVIDER",
              lastActivityAt: event.timestamp,
              idleForMs: 0,
              providerEventReceived: false,
              displayableEventReceived: false,
            };
      break;
    case "llm.completed":
      if (event.stepId !== undefined) {
        settledModelStepIds = rememberSettledStep(settledModelStepIds, event.stepId);
        if (modelWait?.stepId === event.stepId) modelWait = undefined;
      }
      break;
    case "llm.failed":
      if (event.stepId !== undefined) {
        settledModelStepIds = rememberSettledStep(settledModelStepIds, event.stepId);
        if (modelWait?.stepId === event.stepId)
          modelWait = { ...modelWait, phase: "ATTEMPT_FAILED" };
      }
      break;
    case "retry.scheduled":
      modelWait = retryWaitState(modelWait, event, "RETRY_SCHEDULED");
      break;
    case "retry.started":
      modelWait = retryWaitState(modelWait, event, "RETRYING");
      break;
    case "transport.fallback.selected":
      modelWait = {
        ...retryWaitState(modelWait, event, "FALLBACK_SELECTED"),
        fromTransportId: event.payload.fromTransportId,
        toTransportId: event.payload.toTransportId,
      };
      break;
    case "retry.exhausted":
      modelWait = {
        ...retryWaitState(modelWait, event, "RETRY_EXHAUSTED"),
        errorCode: event.payload.errorCode,
        exhaustionReason: event.payload.reason,
      };
      break;
    default:
      break;
  }
  return {
    ...withModelWait(state, modelWait),
    settledModelStepIds,
  };
}

function retryWaitState(
  current: ModelWaitState | undefined,
  event: Extract<
    DurableLiveEvent,
    {
      type: "retry.scheduled" | "retry.started" | "transport.fallback.selected" | "retry.exhausted";
    }
  >,
  phase: ModelWaitPhase,
): ModelWaitState {
  return {
    runId: event.runId,
    ...(event.stepId === undefined
      ? current?.stepId === undefined
        ? {}
        : { stepId: current.stepId }
      : { stepId: event.stepId }),
    phase,
    lastActivityAt:
      phase === "RETRYING" ? event.timestamp : (current?.lastActivityAt ?? event.timestamp),
    idleForMs: phase === "RETRYING" ? 0 : (current?.idleForMs ?? 0),
    providerEventReceived: phase === "RETRYING" ? false : (current?.providerEventReceived ?? false),
    displayableEventReceived:
      phase === "RETRYING" ? false : (current?.displayableEventReceived ?? false),
    ...(current?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: current.idleTimeoutMs }),
    attempt: event.payload.attempt,
    maxAttempts: event.payload.maxAttempts,
    retryOrdinal: event.payload.attempt - 1,
    maxRetries: event.payload.maxAttempts - 1,
    ...(event.type === "retry.scheduled"
      ? {
          delayMs: event.payload.delayMs,
          nextAttemptAt: event.payload.nextAttemptAt,
          errorCode: event.payload.errorCode,
        }
      : {}),
    ...(event.type === "retry.exhausted"
      ? { errorCode: event.payload.errorCode, exhaustionReason: event.payload.reason }
      : {}),
  };
}

function rememberSettledStep(steps: readonly StepId[], stepId: StepId): readonly StepId[] {
  return [...steps.filter((current) => current !== stepId), stepId].slice(-64);
}

function withModelWait(
  state: LiveActivityState,
  modelWait: ModelWaitState | undefined,
): LiveActivityState {
  if (modelWait === undefined) {
    if (state.modelWait === undefined) return state;
    const next = { ...state };
    delete next.modelWait;
    return next;
  }
  return { ...state, modelWait };
}

function isModelStreamEvent(event: TransientLiveEvent): boolean {
  return (
    event.type === "model.status" ||
    event.type === "model.text.delta" ||
    event.type === "model.reasoning_summary.delta" ||
    event.type === "model.tool_call.started" ||
    event.type === "model.tool_call.delta"
  );
}

/**
 * Remove transient rows only after the durable presentation read model has advanced far enough to
 * cover the event that settled them. Active rows and terminal rows beyond the read-model watermark
 * remain visible.
 */
export function pruneProjectedLiveActivities(
  state: LiveActivityState,
  presentationHighWatermark: number,
): LiveActivityState {
  const activities = state.activities.filter(
    (activity) =>
      activity.status === "ACTIVE" ||
      activity.settledAtSequence === undefined ||
      activity.settledAtSequence > presentationHighWatermark,
  );
  return activities.length === state.activities.length ? state : { ...state, activities };
}

function activityFromTransient(event: TransientLiveEvent): LiveActivity | null {
  const common = {
    status: "ACTIVE" as const,
    streamKey: event.durability.streamKey,
    streamSequence:
      event.durability.deliveryClass === "ORDERED" ? event.durability.streamSequence : 0,
    runId: event.runId,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
  };
  switch (event.type) {
    case "model.text.delta":
      return {
        ...common,
        id: `model:text:${event.durability.streamKey}`,
        kind: "MODEL_TEXT",
        text: event.payload.text,
        ...("assistantItemId" in event.payload
          ? { assistantItemId: event.payload.assistantItemId, phase: event.payload.phase }
          : {}),
      };
    case "model.reasoning_summary.delta":
      return {
        ...common,
        id: `model:reasoning:${event.durability.streamKey}`,
        kind: "MODEL_REASONING",
        text: event.payload.text,
      };
    case "model.tool_call.started":
      return {
        ...common,
        id: `model:tool-preparation:${event.durability.streamKey}`,
        kind: "TOOL_PREPARATION",
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        category: toolPresentationCategory(event.payload.toolName),
        title: toolPreparationText(event.payload.toolName),
        text: toolPreparationText(event.payload.toolName),
      };
    case "tool.output":
      return {
        ...common,
        id: `tool-output:${event.payload.invocationId}:${event.payload.stream}`,
        kind: "TOOL_OUTPUT",
        text: event.payload.chunk,
        invocationId: event.payload.invocationId,
      };
    case "shell.output":
      return {
        ...common,
        id: `shell-output:${event.payload.invocationId}:${event.payload.stream}`,
        kind: "SHELL_OUTPUT",
        text: event.payload.chunk,
        invocationId: event.payload.invocationId,
      };
    case "process.output":
      return {
        ...common,
        id: `process-output:${event.payload.processId}:${event.payload.stream}`,
        kind: "PROCESS_OUTPUT",
        text: event.payload.chunk,
        processId: event.payload.processId,
      };
    default:
      return null;
  }
}

function settleForDurableEvent(
  activities: readonly LiveActivity[],
  event: DurableLiveEvent,
): { readonly activities: readonly LiveActivity[]; readonly terminal: boolean } {
  let predicate: ((activity: LiveActivity) => boolean) | undefined;
  let status: Exclude<LiveActivityStatus, "ACTIVE"> | undefined;
  let terminal = false;
  let failedModelStepId: string | undefined;
  switch (event.type) {
    case "tool.completed":
      predicate = (activity) =>
        activity.invocationId === event.payload.invocationId ||
        activity.toolInvocationId === event.payload.invocationId;
      status = "COMPLETED";
      break;
    case "tool.failed":
      predicate = (activity) =>
        activity.invocationId === event.payload.invocationId ||
        activity.toolInvocationId === event.payload.invocationId;
      status = "FAILED";
      break;
    case "shell.completed":
      predicate = (activity) => activity.invocationId === event.payload.invocationId;
      status =
        event.payload.exitCode === 0
          ? "COMPLETED"
          : event.payload.signal === undefined
            ? "FAILED"
            : "CANCELLED";
      break;
    case "process.stopped":
      predicate = (activity) => activity.processId === event.payload.processId;
      status =
        event.payload.status === "EXITED"
          ? "COMPLETED"
          : event.payload.status === "KILLED"
            ? "CANCELLED"
            : "FAILED";
      break;
    case "llm.completed":
      predicate = (activity) => event.stepId !== undefined && activity.stepId === event.stepId;
      status = "COMPLETED";
      break;
    case "llm.failed":
      predicate = (activity) => event.stepId !== undefined && activity.stepId === event.stepId;
      status = "FAILED";
      failedModelStepId = event.stepId;
      break;
    case "run.completed":
      terminal = true;
      predicate = () => true;
      status = "COMPLETED";
      break;
    case "run.failed":
    case "run.timed_out":
    case "budget.exceeded":
      terminal = true;
      predicate = () => true;
      status = "FAILED";
      break;
    case "run.cancelled":
      terminal = true;
      predicate = () => true;
      status = "CANCELLED";
      break;
    default:
      return { activities, terminal: false };
  }
  const settledActivities: readonly LiveActivity[] = activities.map((activity): LiveActivity =>
    predicate?.(activity) && activity.status === "ACTIVE" && status !== undefined
      ? {
          ...activity,
          status,
          ...(activity.kind === "TOOL_ACTIVITY"
            ? {
                toolPhase: (status === "COMPLETED" ? "COMPLETED" : status) as ToolPresentationPhase,
              }
            : {}),
          settledAtSequence: event.durability.sequence,
        }
      : activity,
  );
  return {
    activities: settledActivities.filter(
      (activity) =>
        activity.kind !== "TOOL_PREPARATION" ||
        (!terminal && !(failedModelStepId !== undefined && activity.stepId === failedModelStepId)),
    ),
    terminal,
  };
}

function remember(state: LiveActivityState, eventId: string): LiveActivityState {
  return {
    ...state,
    seenEventIds: [...state.seenEventIds, eventId].slice(-state.maxSeenEventIds),
  };
}

function boundedTextStateFor(activity: LiveActivity, maxBytes: number): BoundedLiveText {
  if (
    activity.retainedBytes !== undefined &&
    activity.truncated !== undefined &&
    activity.omittedBytes !== undefined
  ) {
    return {
      text: activity.text,
      retainedBytes: activity.retainedBytes,
      truncated: activity.truncated,
      omittedBytes: activity.omittedBytes,
    };
  }
  return appendBoundedLiveText(createEmptyBoundedLiveText(), activity.text, maxBytes);
}

function isTransientLiveEvent(event: PublicRunEvent): event is TransientLiveEvent {
  const durability = event.durability;
  return (
    durability.kind === "EPHEMERAL" &&
    "deliveryClass" in durability &&
    typeof durability.streamKey === "string" &&
    (durability.deliveryClass === "COALESCIBLE" ||
      (durability.deliveryClass === "ORDERED" && "streamSequence" in durability))
  );
}

function isDurableLiveEvent(event: PublicRunEvent): event is DurableLiveEvent {
  return event.durability.kind === "DURABLE";
}
