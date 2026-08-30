import { createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  RetryController,
  type RetryDecisionInput,
} from "../src/retry-controller.js";

function input(overrides: Partial<RetryDecisionInput> = {}): RetryDecisionInput {
  return {
    retryable: true,
    attempt: 1,
    steps: 1,
    maxSteps: 10,
    now: createTimestampMs(1_000),
    ...overrides,
  };
}

describe("RetryController", () => {
  it("defaults to three bounded attempts", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0,
    });
  });

  it("stops non-retryable failures", () => {
    expect(new RetryController().decide(input({ retryable: false }))).toEqual({
      kind: "STOP",
      reason: "NOT_RETRYABLE",
    });
  });

  it("stops after the configured attempts", () => {
    expect(new RetryController().decide(input({ attempt: 3 }))).toEqual({
      kind: "STOP",
      reason: "ATTEMPTS_EXHAUSTED",
    });
  });

  it("stops when the next provider step would exceed maxSteps", () => {
    expect(new RetryController().decide(input({ steps: 10, maxSteps: 10 }))).toEqual({
      kind: "STOP",
      reason: "MAX_STEPS_REACHED",
    });
  });

  it("calculates bounded exponential delays with deterministic jitter", () => {
    const controller = new RetryController({
      policy: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 3_000, jitterRatio: 0 },
    });
    expect(controller.decide(input({ attempt: 1 })).delayMs).toBe(1_000);
    expect(controller.decide(input({ attempt: 2 })).delayMs).toBe(2_000);
    expect(controller.decide(input({ attempt: 3 })).delayMs).toBe(3_000);
    expect(controller.decide(input({ attempt: 9 })).delayMs).toBe(3_000);

    const minimum = new RetryController({
      policy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 3_000, jitterRatio: 0.5 },
      jitter: { next: () => 0 },
    });
    const maximum = new RetryController({
      policy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 3_000, jitterRatio: 0.5 },
      jitter: { next: () => 0.999999 },
    });
    expect(minimum.decide(input()).delayMs).toBe(500);
    expect(maximum.decide(input()).delayMs).toBe(1_499);
  });

  it("rejects an invalid jitter source", () => {
    const controller = new RetryController({
      policy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 3_000, jitterRatio: 0.5 },
      jitter: { next: () => 1 },
    });
    expect(() => controller.decide(input())).toThrow("Retry jitter source");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid Retry-After %s",
    (retryAfterMs) => {
      const controller = new RetryController();
      expect(controller.decide(input({ attempt: 2, retryAfterMs })).delayMs).toBe(2_000);
    },
  );

  it("uses a bounded valid Retry-After hint before exponential backoff", () => {
    const controller = new RetryController();
    expect(controller.decide(input({ attempt: 2, retryAfterMs: 2_500 })).delayMs).toBe(2_500);
    expect(controller.decide(input({ attempt: 2, retryAfterMs: 40_000 })).delayMs).toBe(2_000);
  });

  it("does not overflow while calculating a large bounded delay", () => {
    const controller = new RetryController({
      policy: { maxAttempts: 10, baseDelayMs: Number.MAX_SAFE_INTEGER, maxDelayMs: Number.MAX_SAFE_INTEGER, jitterRatio: 0 },
    });
    expect(controller.decide(input({ attempt: 9 })).delayMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("stops instead of scheduling a retry that reaches the deadline", () => {
    const controller = new RetryController();
    expect(
      controller.decide(
        input({ now: createTimestampMs(1_000), deadlineAt: createTimestampMs(2_000) }),
      ),
    ).toEqual({ kind: "STOP", reason: "DEADLINE_EXCEEDED" });
  });
});
