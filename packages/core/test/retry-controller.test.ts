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

function delayOf(decision: ReturnType<RetryController["decide"]>): number {
  if (decision.kind !== "RETRY") throw new Error("expected a retry decision");
  return decision.delayMs;
}

describe("RetryController", () => {
  it("defaults to six total attempts and bounded randomized backoff", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 6,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.1,
      maxProviderRetryAfterMs: 300_000,
    });
  });

  it("stops non-retryable failures", () => {
    expect(new RetryController().decide(input({ retryable: false }))).toEqual({
      kind: "STOP",
      reason: "NOT_RETRYABLE",
    });
  });

  it("keeps cancellation ahead of deadline, limits, and Retry-After policy checks", () => {
    expect(
      new RetryController().decide(
        input({
          cancelled: true,
          retryable: false,
          attempt: 6,
          steps: 10,
          now: createTimestampMs(2_000),
          deadlineAt: createTimestampMs(2_000),
          retryAfterMs: 300_001,
        }),
      ),
    ).toEqual({ kind: "STOP", reason: "CANCELLED" });
  });

  it("stops after the configured attempts", () => {
    expect(new RetryController().decide(input({ attempt: 6 }))).toEqual({
      kind: "STOP",
      reason: "ATTEMPTS_EXHAUSTED",
    });
  });

  it("schedules exactly five retries after the initial attempt", () => {
    const controller = new RetryController({ jitter: { next: () => 0.5 } });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(controller.decide(input({ attempt }))).toEqual({
        kind: "RETRY",
        attempt: attempt + 1,
        delayMs: 1_000 * 2 ** (attempt - 1),
      });
    }
    expect(controller.decide(input({ attempt: 6 }))).toEqual({
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
      policy: {
        maxAttempts: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        jitterRatio: 0,
        maxProviderRetryAfterMs: 300_000,
      },
    });
    expect(delayOf(controller.decide(input({ attempt: 1 })))).toBe(1_000);
    expect(delayOf(controller.decide(input({ attempt: 2 })))).toBe(2_000);
    expect(delayOf(controller.decide(input({ attempt: 3 })))).toBe(3_000);
    expect(delayOf(controller.decide(input({ attempt: 9 })))).toBe(3_000);

    const minimum = new RetryController({
      policy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        jitterRatio: 0.5,
        maxProviderRetryAfterMs: 300_000,
      },
      jitter: { next: () => 0 },
    });
    const maximum = new RetryController({
      policy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        jitterRatio: 0.5,
        maxProviderRetryAfterMs: 300_000,
      },
      jitter: { next: () => 0.999999 },
    });
    expect(delayOf(minimum.decide(input()))).toBe(500);
    expect(delayOf(maximum.decide(input()))).toBe(1_499);

    const defaultMinimum = new RetryController({ jitter: { next: () => 0 } });
    const defaultNeutral = new RetryController({ jitter: { next: () => 0.5 } });
    const defaultMaximum = new RetryController({ jitter: { next: () => 0.999999 } });
    expect(delayOf(defaultMinimum.decide(input()))).toBe(900);
    expect(delayOf(defaultNeutral.decide(input()))).toBe(1_000);
    expect(delayOf(defaultMaximum.decide(input()))).toBe(1_099);
  });

  it("rejects an invalid jitter source", () => {
    const controller = new RetryController({
      policy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        jitterRatio: 0.5,
        maxProviderRetryAfterMs: 300_000,
      },
      jitter: { next: () => 1 },
    });
    expect(() => controller.decide(input())).toThrow("Retry jitter source");
  });

  it("keeps jittered delays strictly positive", () => {
    const controller = new RetryController({
      policy: {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 1,
        maxProviderRetryAfterMs: 300_000,
      },
      jitter: { next: () => 0 },
    });
    expect(delayOf(controller.decide(input()))).toBe(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid Retry-After %s",
    (retryAfterMs) => {
      const controller = new RetryController({ jitter: { next: () => 0.5 } });
      expect(delayOf(controller.decide(input({ attempt: 2, retryAfterMs })))).toBe(2_000);
    },
  );

  it("uses Retry-After exactly even beyond the local exponential cap", () => {
    const controller = new RetryController({ jitter: { next: () => 0 } });
    expect(delayOf(controller.decide(input({ attempt: 2, retryAfterMs: 2_500 })))).toBe(2_500);
    expect(delayOf(controller.decide(input({ attempt: 2, retryAfterMs: 250_000 })))).toBe(250_000);
  });

  it("honors Retry-After zero as a scheduled retry and rejects hints over the Provider cap", () => {
    const controller = new RetryController({ jitter: { next: () => 0.5 } });
    expect(controller.decide(input({ attempt: 2, retryAfterMs: 0 }))).toEqual({
      kind: "RETRY",
      attempt: 3,
      delayMs: 0,
    });
    expect(controller.decide(input({ attempt: 2, retryAfterMs: 300_001 }))).toEqual({
      kind: "STOP",
      reason: "RETRY_AFTER_EXCEEDS_POLICY",
    });
  });

  it("does not overflow while calculating a large bounded delay", () => {
    const controller = new RetryController({
      policy: {
        maxAttempts: 10,
        baseDelayMs: Number.MAX_SAFE_INTEGER,
        maxDelayMs: Number.MAX_SAFE_INTEGER,
        jitterRatio: 0,
        maxProviderRetryAfterMs: 300_000,
      },
    });
    expect(delayOf(controller.decide(input({ attempt: 9 })))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("stops instead of scheduling a retry that reaches the deadline", () => {
    expect(
      new RetryController({ jitter: { next: () => 0.5 } }).decide(
        input({ now: createTimestampMs(1_000), deadlineAt: createTimestampMs(2_000) }),
      ),
    ).toEqual({ kind: "STOP", reason: "DEADLINE_EXCEEDED" });
  });
});
