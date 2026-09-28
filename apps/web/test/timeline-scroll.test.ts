import { describe, expect, it } from "vitest";
import {
  isNearTimelineBottom,
  timelineActivityCount,
  timelineActivityDelta,
  timelineFollowState,
} from "../src/components/timeline-scroll.js";

describe("Timeline scroll behavior", () => {
  it("follows while the user is within the bottom threshold", () => {
    expect(isNearTimelineBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 })).toBe(
      true,
    );
    expect(isNearTimelineBottom({ scrollTop: 840, clientHeight: 100, scrollHeight: 1000 })).toBe(
      false,
    );
  });

  it("detaches follow and counts only activities added while detached", () => {
    expect(timelineFollowState(false, 4, 6)).toEqual({ following: false, newActivityCount: 2 });
    expect(timelineActivityDelta(false, 6, 7)).toBe(1);
  });

  it("clears the indicator and resumes follow after jumping to latest", () => {
    expect(timelineFollowState(true, 6, 7)).toEqual({ following: true, newActivityCount: 0 });
    expect(timelineActivityDelta(true, 6, 7)).toBe(0);
  });

  it("counts retry activity for the detached new-activity indicator", () => {
    expect(
      timelineActivityCount(
        {
          activeLlm: [],
          activeTools: [],
          activeProcesses: [],
          activeApprovals: [],
          settled: [],
          verification: [],
          retries: [
            { id: "retry-1", attempt: 1, text: "Retry 1", started: false, status: "PENDING" },
          ],
          currentPlan: [],
        } as never,
        undefined,
      ),
    ).toBe(1);
  });
});
