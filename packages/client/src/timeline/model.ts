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
  | "FILE"
  | "SHELL"
  | "REASONING"
  | "SYSTEM";
export type TimelineEntryStatus =
  | "ACTIVE"
  | "REQUESTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "PENDING"
  | "SKIPPED"
  | "INTERRUPTED"
  | "RESOLVED"
  | "FINALIZED"
  | "PASSED"
  | "ERROR";

export interface TimelineEntry {
  readonly id: string;
  readonly runId?: RunId;
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
  readonly invocationId?: string;
  readonly processId?: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly riskLevel?: string;
  readonly scope?: string;
  readonly usage?: Readonly<{
    inputTokens: number;
    outputTokens: number;
    steps: number;
    toolCalls: number;
  }>;
  readonly counts?: Readonly<{
    total: number;
    failed: number;
    error: number;
  }>;
}

export interface TimelineVerificationCheck {
  readonly id: string;
  readonly checkId: string;
  readonly label: string;
  readonly title: string;
  readonly status: TimelineEntryStatus;
  readonly detail?: string;
}
export interface TimelineVerificationGroup {
  readonly id: string;
  readonly planId: string;
  readonly label: string;
  readonly status: TimelineEntryStatus;
  readonly checks: readonly TimelineVerificationCheck[];
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly plannedCounts?: Readonly<{
    required: number;
    ifAvailable: number;
    advisory: number;
  }>;
  readonly checkCount?: number;
}
export interface TimelineRetry {
  readonly id: string;
  readonly attempt: number;
  readonly text: string;
  readonly started: boolean;
  readonly reason?: string;
  readonly status: TimelineEntryStatus;
}
export interface TimelineSeenEvent {
  readonly eventId: string;
  readonly sequence?: number;
}
export interface TimelineVerificationOutcome {
  readonly id: string;
  readonly planId: string;
  readonly checkId: string;
  readonly status: "PASSED" | "FAILED" | "ERROR";
}
export interface TimelineVerificationPlan {
  readonly id: string;
  readonly planId: string;
  readonly checkCount: number;
}
export interface TimelineVerificationOutcomeIntegrity {
  readonly affectedPlanIds: readonly string[];
  readonly unknownAffected: boolean;
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
  readonly currentPlan: readonly TimelineEntry[];
  readonly lastDurableSequence: number;
  readonly seenEvents: readonly TimelineSeenEvent[];
  readonly verificationOutcomes: readonly TimelineVerificationOutcome[];
  readonly verificationPlans: readonly TimelineVerificationPlan[];
  readonly verificationOutcomeIntegrity: TimelineVerificationOutcomeIntegrity;
  readonly omittedActivity: boolean;
  readonly error?: string;
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
    currentPlan: [],
    lastDurableSequence: 0,
    seenEvents: [],
    verificationOutcomes: [],
    verificationPlans: [],
    verificationOutcomeIntegrity: { affectedPlanIds: [], unknownAffected: false },
    omittedActivity: false,
  };
}
