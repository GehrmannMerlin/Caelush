export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0,
});

export const MAX_RETRY_ATTEMPTS = 10;

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("Retry maxAttempts must be a safe positive integer.");
  }
  if (policy.maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new Error(`Retry maxAttempts must not exceed ${MAX_RETRY_ATTEMPTS}.`);
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs <= 0) {
    throw new Error("Retry baseDelayMs must be a safe positive integer.");
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("Retry maxDelayMs must be a safe integer at least baseDelayMs.");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error("Retry jitterRatio must be a finite number between 0 and 1.");
  }
  return Object.freeze({ ...policy });
}
