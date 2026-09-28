import type { LiveActivityState, TimelineState } from "@caelush/client";

export const TIMELINE_BOTTOM_THRESHOLD_PX = 48;
export const MAX_NEW_ACTIVITY_COUNT = 99;

export interface TimelineScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

export function timelineActivityCount(
  timeline: Pick<
    TimelineState,
    | "activeLlm"
    | "activeTools"
    | "activeProcesses"
    | "activeApprovals"
    | "settled"
    | "verification"
    | "retries"
    | "currentPlan"
    | "resourceGuard"
  >,
  liveActivity: Pick<LiveActivityState, "activities"> | undefined,
): number {
  return (
    timeline.activeLlm.length +
    timeline.activeTools.length +
    timeline.activeProcesses.length +
    timeline.activeApprovals.length +
    timeline.settled.length +
    (liveActivity?.activities.length ?? 0) +
    timeline.verification.reduce((count, group) => count + group.checks.length, 0) +
    timeline.retries.length +
    timeline.currentPlan.length +
    (timeline.resourceGuard === undefined ? 0 : 1)
  );
}

export function isNearTimelineBottom(
  metrics: TimelineScrollMetrics,
  threshold = TIMELINE_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - threshold;
}

export function timelineActivityDelta(
  following: boolean,
  previousActivityCount: number,
  currentActivityCount: number,
): number {
  if (following || currentActivityCount <= previousActivityCount) return 0;
  return Math.min(MAX_NEW_ACTIVITY_COUNT, currentActivityCount - previousActivityCount);
}

export function timelineFollowState(
  following: boolean,
  previousActivityCount: number,
  currentActivityCount: number,
): { readonly following: boolean; readonly newActivityCount: number } {
  return {
    following,
    newActivityCount: timelineActivityDelta(following, previousActivityCount, currentActivityCount),
  };
}
