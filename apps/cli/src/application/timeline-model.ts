import type {
  PlanItem,
  ProcessStatus,
  RunId,
  RunStatus,
  StepId,
  ToolInvocationId,
  VerificationCheckId,
  VerificationPlanId,
} from "@caelush/protocol";

export type CliTimelineEntryKind =
  | "TOOL"
  | "FILE"
  | "SHELL"
  | "PROCESS"
  | "REASONING"
  | "PLAN"
  | "RETRY"
  | "VERIFICATION"
  | "APPROVAL"
  | "ERROR"
  | "BUDGET";

export type CliTimelineEntryStatus =
  | "REQUESTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "PENDING"
  | "RESOLVED"
  | "FINALIZED";

export interface CliTimelineEntry {
  readonly id: string;
  readonly kind: CliTimelineEntryKind;
  readonly title: string;
  readonly text: string;
  readonly status?: CliTimelineEntryStatus;
  readonly runId?: RunId | undefined;
  readonly stepId?: StepId | undefined;
  readonly invocationId?: ToolInvocationId | undefined;
  readonly processId?: string | undefined;
  readonly planId?: VerificationPlanId | undefined;
  readonly checkId?: VerificationCheckId | undefined;
}

export interface CliTimelineVerificationCheck {
  readonly checkId: VerificationCheckId;
  readonly status: "RUNNING" | "PASSED" | "FAILED" | "ERROR" | "SKIPPED" | "CANCELLED";
  readonly title: string;
}

export interface CliTimelineVerificationGroup {
  readonly planId: VerificationPlanId;
  readonly checkCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly skipped: number;
  readonly finalized: boolean;
  readonly outcome?: "PASSED" | "FAILED" | "ERROR";
  readonly checks: readonly CliTimelineVerificationCheck[];
}

export interface CliTimelineRetry {
  readonly id: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly text: string;
  readonly started: boolean;
}

export interface CliTimelineState {
  readonly runId?: RunId;
  readonly limits: CliTimelineLimits;
  readonly settled: readonly CliTimelineEntry[];
  readonly activeTools: readonly CliTimelineEntry[];
  readonly activeApprovals: readonly CliTimelineEntry[];
  readonly activeProcesses: readonly CliTimelineEntry[];
  readonly currentPlan?: readonly PlanItem[];
  readonly verification: readonly CliTimelineVerificationGroup[];
  readonly retries: readonly CliTimelineRetry[];
  readonly lastDurableSequence: number;
  readonly seenEvents: readonly { readonly eventId: string; readonly sequence?: number }[];
  readonly omittedActivity: boolean;
  readonly error?: string;
}

export interface CliTimelineOptions {
  readonly maxTextBytes?: number;
  readonly maxSettledEntries?: number;
  readonly maxActiveEntries?: number;
  readonly maxSeenEvents?: number;
}

export interface CliTimelineLimits {
  readonly maxTextBytes: number;
  readonly maxSettledEntries: number;
  readonly maxActiveEntries: number;
  readonly maxSeenEvents: number;
}

export const DEFAULT_CLI_TIMELINE_LIMITS: CliTimelineLimits = Object.freeze({
  maxTextBytes: 8 * 1024,
  maxSettledEntries: 256,
  maxActiveEntries: 32,
  maxSeenEvents: 1024,
});

export function resolveCliTimelineLimits(options: CliTimelineOptions = {}): CliTimelineLimits {
  return {
    maxTextBytes: positiveLimit(options.maxTextBytes, DEFAULT_CLI_TIMELINE_LIMITS.maxTextBytes),
    maxSettledEntries: positiveLimit(
      options.maxSettledEntries,
      DEFAULT_CLI_TIMELINE_LIMITS.maxSettledEntries,
    ),
    maxActiveEntries: positiveLimit(
      options.maxActiveEntries,
      DEFAULT_CLI_TIMELINE_LIMITS.maxActiveEntries,
    ),
    maxSeenEvents: positiveLimit(options.maxSeenEvents, DEFAULT_CLI_TIMELINE_LIMITS.maxSeenEvents),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createInitialCliTimelineState(
  runId?: RunId,
  options: CliTimelineOptions = {},
): CliTimelineState {
  const limits = resolveCliTimelineLimits(options);
  return {
    ...(runId === undefined ? {} : { runId }),
    limits,
    settled: [],
    activeTools: [],
    activeApprovals: [],
    activeProcesses: [],
    verification: [],
    retries: [],
    lastDurableSequence: 0,
    seenEvents: [],
    omittedActivity: false,
  };
}

export function processStatusLabel(status: ProcessStatus): string {
  switch (status) {
    case "STARTING":
      return "starting";
    case "RUNNING":
      return "running";
    case "EXITED":
      return "exited";
    case "FAILED":
      return "failed";
    case "KILLED":
      return "killed";
  }
}

export function runStatusLabel(status: RunStatus): string {
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
