import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../src/errors/retry-after.js";

const NOW = Date.parse("2026-10-04T00:00:00.000Z");

describe("parseRetryAfterMs", () => {
  it.each([
    ["2", 2_000],
    ["0.5", 500],
    ["0", 0],
    ["1.2345", 1_235],
  ])("parses delta seconds %s as %s milliseconds", (raw, expected) => {
    expect(parseRetryAfterMs(raw, NOW)).toBe(expected);
  });

  it("parses an HTTP-date relative to the supplied clock", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", NOW)).toBe(
      Date.parse("2026-10-21T07:28:00.000Z") - NOW,
    );
  });

  it("treats an HTTP-date in the past as due now", () => {
    expect(parseRetryAfterMs("Thu, 01 Oct 2026 00:00:00 GMT", NOW)).toBe(0);
  });

  it.each([
    undefined,
    "",
    " ",
    "-5",
    "1e3",
    "NaN",
    "Infinity",
    "not a date",
    "Wed, 32 Oct 2026 07:28:00 GMT",
    "9007199254740.992",
  ])("rejects malformed Retry-After value %s", (raw) => {
    expect(parseRetryAfterMs(raw, NOW)).toBeUndefined();
  });

  it("rejects an invalid clock instead of fabricating a delay", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", Number.POSITIVE_INFINITY)).toBe(
      undefined,
    );
  });
});
