import type { RunId } from "@caelush/protocol";

export type TimelineEntryKind =
  | "USER"
  | "ASSISTANT"
  | "TOOL"
  | "APPROVAL"
  | "PROCESS"
  | "LLM"
  | "VERIFICATION"
  | "RETRY"
  | "SYSTEM";
export type TimelineEntryStatus =
  "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED" | "PENDING" | "SKIPPED";

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineEntryKind;
  readonly status: TimelineEntryStatus;
  readonly title?: string;
  readonly text?: string;
  readonly detail?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly sequence?: number;
  readonly toolName?: string;
  readonly filePath?: string;
}

export interface TimelineVerificationCheck {
  readonly id: string;
  readonly label: string;
  readonly status: TimelineEntryStatus;
  readonly detail?: string;
}
export interface TimelineVerificationGroup {
  readonly id: string;
  readonly label: string;
  readonly status: TimelineEntryStatus;
  readonly checks: readonly TimelineVerificationCheck[];
}
export interface TimelineRetry {
  readonly id: string;
  readonly attempt: number;
  readonly reason?: string;
  readonly status: TimelineEntryStatus;
}

export interface TimelineLimits {
  readonly maxTextBytes: number;
  readonly maxSettledEntries: number;
  readonly maxActiveEntries: number;
  readonly maxSeenEvents: number;
}
export interface TimelineOptions {
  readonly limits?: Partial<TimelineLimits>;
}
export interface TimelineState {
  readonly runId?: RunId;
  readonly limits: TimelineLimits;
  readonly settled: readonly TimelineEntry[];
  readonly activeTools: readonly TimelineEntry[];
  readonly activeApprovals: readonly TimelineEntry[];
  readonly activeProcesses: readonly TimelineEntry[];
  readonly activeLlm: readonly TimelineEntry[];
  readonly verification: readonly TimelineVerificationGroup[];
  readonly retries: readonly TimelineRetry[];
  readonly lastDurableSequence: number;
  readonly seenEvents: readonly string[];
  readonly omittedActivity: boolean;
}

export const DEFAULT_TIMELINE_LIMITS: TimelineLimits = Object.freeze({
  maxTextBytes: 8 * 1024,
  maxSettledEntries: 256,
  maxActiveEntries: 32,
  maxSeenEvents: 1024,
});
export function resolveTimelineLimits(options: TimelineOptions = {}): TimelineLimits {
  const supplied = options.limits ?? {};
  const valid = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return Object.freeze({
    maxTextBytes: valid(supplied.maxTextBytes, DEFAULT_TIMELINE_LIMITS.maxTextBytes),
    maxSettledEntries: valid(supplied.maxSettledEntries, DEFAULT_TIMELINE_LIMITS.maxSettledEntries),
    maxActiveEntries: valid(supplied.maxActiveEntries, DEFAULT_TIMELINE_LIMITS.maxActiveEntries),
    maxSeenEvents: valid(supplied.maxSeenEvents, DEFAULT_TIMELINE_LIMITS.maxSeenEvents),
  });
}
export function createInitialTimelineState(
  runId?: RunId,
  options: TimelineOptions = {},
): TimelineState {
  const limits = resolveTimelineLimits(options);
  return {
    ...(runId === undefined ? {} : { runId }),
    limits,
    settled: [],
    activeTools: [],
    activeApprovals: [],
    activeProcesses: [],
    activeLlm: [],
    verification: [],
    retries: [],
    lastDurableSequence: 0,
    seenEvents: [],
    omittedActivity: false,
  };
}
