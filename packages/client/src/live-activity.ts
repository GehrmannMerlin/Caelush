import type { PublicRunEvent, RunId } from "@caelush/protocol";

export type LiveActivityKind =
  | "MODEL_TEXT"
  | "MODEL_REASONING"
  | "MODEL_TOOL_CALL"
  | "TOOL_OUTPUT"
  | "SHELL_OUTPUT"
  | "PROCESS_OUTPUT";
export type LiveActivityStatus = "ACTIVE" | "SETTLED";

export interface LiveActivity {
  readonly id: string;
  readonly kind: LiveActivityKind;
  readonly status: LiveActivityStatus;
  readonly text: string;
  readonly streamKey: string;
  readonly streamSequence: number;
  readonly runId: RunId;
  readonly stepId?: string;
  readonly invocationId?: string;
  readonly processId?: string;
}

export interface LiveActivityState {
  readonly runId?: RunId;
  readonly activities: readonly LiveActivity[];
  readonly seenEventIds: readonly string[];
  readonly lastStreamSequences: Readonly<Record<string, number>>;
  readonly lastDurableSequence: number;
  readonly terminal: boolean;
  readonly maxActivities: number;
  readonly maxTextBytes: number;
  readonly maxSeenEventIds: number;
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
    if (
      event.durability.deliveryClass === "ORDERED" &&
      event.durability.streamSequence <=
        (state.lastStreamSequences[event.durability.streamKey] ?? 0)
    ) {
      return state;
    }
    const activity = activityFromTransient(event);
    if (activity === null) return remember(state, event.eventId);
    const existing = state.activities.find((item) => item.id === activity.id);
    const nextActivity: LiveActivity = {
      ...activity,
      ...(existing === undefined
        ? {}
        : {
            text: appendBounded(existing.text, activity.text, state.maxTextBytes),
            status: existing.status === "SETTLED" ? "SETTLED" : activity.status,
          }),
    };
    const activities = [
      ...state.activities.filter((item) => item.id !== activity.id),
      nextActivity,
    ].slice(-state.maxActivities);
    return {
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
  }

  if (!isDurableLiveEvent(event)) return remember(state, event.eventId);
  const sequence = event.durability.sequence;
  if (sequence <= state.lastDurableSequence) return state;
  const settled = settleForDurableEvent(state.activities, event);
  return {
    ...remember(state, event.eventId),
    activities: settled.activities,
    lastDurableSequence: sequence,
    terminal: settled.terminal || state.terminal,
  };
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
      };
    case "model.reasoning_summary.delta":
      return {
        ...common,
        id: `model:reasoning:${event.durability.streamKey}`,
        kind: "MODEL_REASONING",
        text: event.payload.text,
      };
    case "model.tool_call.delta":
      return {
        ...common,
        id: `model:tool-call:${event.durability.streamKey}`,
        kind: "MODEL_TOOL_CALL",
        text: event.payload.delta,
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
  let terminal = false;
  switch (event.type) {
    case "tool.completed":
    case "tool.failed":
      predicate = (activity) => activity.invocationId === event.payload.invocationId;
      break;
    case "shell.completed":
      predicate = (activity) => activity.invocationId === event.payload.invocationId;
      break;
    case "process.stopped":
      predicate = (activity) => activity.processId === event.payload.processId;
      break;
    case "llm.completed":
    case "llm.failed":
      predicate = (activity) => event.stepId !== undefined && activity.stepId === event.stepId;
      break;
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.timed_out":
      terminal = true;
      predicate = () => true;
      break;
    default:
      return { activities, terminal: false };
  }
  return {
    activities: activities.map((activity) =>
      predicate?.(activity) ? { ...activity, status: "SETTLED" } : activity,
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

function appendBounded(previous: string, next: string, maxBytes: number): string {
  return truncateUtf8(`${previous}${next}`, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8ByteLength(`${result}${character}`) > maxBytes) break;
    result += character;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
