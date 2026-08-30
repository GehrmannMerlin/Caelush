import type { TimestampMs } from "@caelush/protocol";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, validateRetryPolicy } from "./retry-policy.js";

export interface RetryJitterSource {
  next(): number;
}

export interface RetryDecisionInput {
  readonly retryable: boolean;
  readonly attempt: number;
  readonly steps: number;
  readonly maxSteps: number;
  readonly now: TimestampMs;
  readonly deadlineAt?: TimestampMs;
  readonly cancelled?: boolean;
  readonly retryAfterMs?: number;
}

export type RetryStopReason =
  "NOT_RETRYABLE" | "ATTEMPTS_EXHAUSTED" | "CANCELLED" | "DEADLINE_EXCEEDED" | "MAX_STEPS_REACHED";

export type RetryDecision =
  | { readonly kind: "RETRY"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "STOP"; readonly reason: RetryStopReason };

export interface RetryControllerOptions {
  readonly policy?: RetryPolicy;
  readonly jitter?: RetryJitterSource;
}

export class RetryController {
  private readonly policy: RetryPolicy;
  private readonly jitter: RetryJitterSource;

  constructor(options: RetryControllerOptions = {}) {
    this.policy = validateRetryPolicy(options.policy ?? DEFAULT_RETRY_POLICY);
    this.jitter = options.jitter ?? { next: () => 0 };
  }

  get maxAttempts(): number {
    return this.policy.maxAttempts;
  }

  decide(input: RetryDecisionInput): RetryDecision {
    if (input.cancelled === true) return { kind: "STOP", reason: "CANCELLED" };
    if (input.deadlineAt !== undefined && input.now >= input.deadlineAt) {
      return { kind: "STOP", reason: "DEADLINE_EXCEEDED" };
    }
    if (input.steps >= input.maxSteps) {
      return { kind: "STOP", reason: "MAX_STEPS_REACHED" };
    }
    if (!input.retryable) return { kind: "STOP", reason: "NOT_RETRYABLE" };
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new Error("Retry attempt must be a safe positive integer.");
    }
    if (input.attempt >= this.policy.maxAttempts) {
      return { kind: "STOP", reason: "ATTEMPTS_EXHAUSTED" };
    }
    const delayMs = this.delayFor(input);
    if (input.deadlineAt !== undefined && delayMs >= input.deadlineAt - input.now) {
      return { kind: "STOP", reason: "DEADLINE_EXCEEDED" };
    }
    return {
      kind: "RETRY",
      attempt: input.attempt + 1,
      delayMs,
    };
  }

  private delayFor(input: RetryDecisionInput): number {
    if (isValidRetryAfter(input.retryAfterMs, this.policy.maxDelayMs)) {
      return input.retryAfterMs;
    }
    const retryIndex = input.attempt - 1;
    let delay = this.policy.baseDelayMs;
    for (let index = 0; index < retryIndex && delay < this.policy.maxDelayMs; index += 1) {
      delay = delay > Math.floor(this.policy.maxDelayMs / 2) ? this.policy.maxDelayMs : delay * 2;
    }
    if (this.policy.jitterRatio === 0) return delay;
    const sample = this.jitter.next();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error("Retry jitter source must return a finite number in [0, 1).");
    }
    const factor = 1 + (sample * 2 - 1) * this.policy.jitterRatio;
    return Math.min(this.policy.maxDelayMs, Math.max(1, Math.floor(delay * factor)));
  }
}

function isValidRetryAfter(value: number | undefined, maxDelayMs: number): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maxDelayMs;
}

export { DEFAULT_RETRY_POLICY, MAX_RETRY_ATTEMPTS, validateRetryPolicy } from "./retry-policy.js";
export type { RetryPolicy } from "./retry-policy.js";
