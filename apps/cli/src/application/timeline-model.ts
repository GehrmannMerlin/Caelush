import {
  DEFAULT_TIMELINE_LIMITS,
  createInitialTimelineState,
  resolveTimelineLimits,
} from "@caelush/client";
export { processStatusLabel, runStatusLabel, formatRunTerminal } from "@caelush/client";
import type {
  TimelineEntry,
  TimelineEntryKind,
  TimelineEntryStatus,
  TimelineLimits,
  TimelineOptions,
  TimelineRetry,
  TimelineState,
  TimelineVerificationCheck,
  TimelineVerificationGroup,
} from "@caelush/client";

export type CliTimelineEntryKind = TimelineEntryKind;
export type CliTimelineEntryStatus = TimelineEntryStatus;
export type CliTimelineEntry = TimelineEntry;
export type CliTimelineVerificationCheck = TimelineVerificationCheck;
export type CliTimelineVerificationGroup = TimelineVerificationGroup;
export type CliTimelineRetry = TimelineRetry;
export type CliTimelineState = TimelineState;
export type CliTimelineLimits = TimelineLimits;
export type CliTimelineOptions = TimelineOptions & Partial<CliTimelineLimits>;

export const DEFAULT_CLI_TIMELINE_LIMITS = DEFAULT_TIMELINE_LIMITS;
export function createInitialCliTimelineState(
  runId?: import("@caelush/protocol").RunId,
  options: CliTimelineOptions = {},
) {
  return createInitialTimelineState(runId, {
    limits: {
      ...options.limits,
      ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
      ...(options.maxSettledEntries === undefined
        ? {}
        : { maxSettledEntries: options.maxSettledEntries }),
      ...(options.maxActiveEntries === undefined
        ? {}
        : { maxActiveEntries: options.maxActiveEntries }),
      ...(options.maxSeenEvents === undefined ? {} : { maxSeenEvents: options.maxSeenEvents }),
    },
  });
}
export function resolveCliTimelineLimits(options: CliTimelineOptions = {}) {
  return resolveTimelineLimits({ limits: { ...options.limits, ...options } });
}
