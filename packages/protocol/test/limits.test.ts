import { describe, expect, it } from "vitest";
import { RunLimitsSchema } from "../src/index.js";

const base = { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1_000 };

describe("RunLimits budget validation", () => {
  it("requires every integer limit to be a safe positive integer", () => {
    expect(
      RunLimitsSchema.safeParse({
        ...base,
        maxSteps: Number.MAX_SAFE_INTEGER,
        maxToolCalls: Number.MAX_SAFE_INTEGER,
        maxTokens: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);

    for (const key of ["maxSteps", "maxToolCalls", "maxTokens"] as const) {
      expect(
        RunLimitsSchema.safeParse({
          ...base,
          [key]: Number.MAX_SAFE_INTEGER + 1,
        }).success,
      ).toBe(false);
    }
  });

  it("requires maxCost to be a finite positive USD amount", () => {
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: 2.5 }).success).toBe(true);
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: 0 }).success).toBe(false);
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: -1 }).success).toBe(false);
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: 0.0000001 }).success).toBe(false);
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: Number.MAX_SAFE_INTEGER }).success).toBe(
      false,
    );
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: Number.NaN }).success).toBe(false);
    expect(RunLimitsSchema.safeParse({ ...base, maxCost: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });
});
