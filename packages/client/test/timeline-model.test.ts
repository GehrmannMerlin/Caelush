import { describe, expect, it } from "vitest";
import { DEFAULT_TIMELINE_LIMITS, resolveTimelineLimits } from "../src/timeline/model.js";

describe("shared Timeline limits", () => {
  it("falls back to defaults for invalid boundedness limits", () => {
    expect(
      resolveTimelineLimits({
        limits: {
          maxTextBytes: Number.NaN,
          maxSettledEntries: Infinity,
          maxActiveEntries: 0,
          maxSeenEvents: -1,
        },
      }),
    ).toEqual(DEFAULT_TIMELINE_LIMITS);
  });

  it("falls back to defaults for fractional and unsafe limits", () => {
    expect(
      resolveTimelineLimits({
        limits: {
          maxTextBytes: 1.5,
          maxSettledEntries: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toEqual(DEFAULT_TIMELINE_LIMITS);
  });
});
