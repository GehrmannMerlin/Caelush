import { describe, expect, it } from "vitest";
import { costMicrosForTokens, usdToCostMicros } from "../src/cost-micros.js";

describe("micro-USD arithmetic", () => {
  it("converts decimal USD deterministically and rounds cost upward", () => {
    expect(usdToCostMicros(2.5)).toBe(2_500_000);
    expect(usdToCostMicros(0.0000019)).toBe(1);
    expect(costMicrosForTokens(1, 1_000_000)).toBe(1);
    expect(costMicrosForTokens(1, 1_000_001)).toBe(2);
  });

  it("rejects invalid or overflowing values", () => {
    expect(() => usdToCostMicros(0)).toThrow();
    expect(() => usdToCostMicros(Number.NaN)).toThrow();
    expect(() => costMicrosForTokens(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
