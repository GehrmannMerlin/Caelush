/**
 * Maximum cache-miss growth compatible with a target hit fraction when `reusableTokens` are
 * expected to hit. This is advisory only: required Tool results or other necessary information must
 * never be dropped to satisfy the estimate.
 */
export function maxNewTokensForTarget(input: {
  readonly reusableTokens: number;
  readonly target: number;
}): number {
  if (!Number.isSafeInteger(input.reusableTokens) || input.reusableTokens < 0) {
    throw new RangeError("reusableTokens must be a non-negative safe integer.");
  }
  if (!Number.isFinite(input.target) || input.target <= 0 || input.target > 1) {
    throw new RangeError("target must be greater than zero and at most one.");
  }
  const maximum = Math.floor((input.reusableTokens * (1 - input.target)) / input.target);
  if (!Number.isSafeInteger(maximum)) {
    throw new RangeError("Cache growth suggestion exceeds the safe integer range.");
  }
  return maximum;
}
