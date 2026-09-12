import { assertExactKeys, describeValue } from "../internal/assertions.js";

/**
 * The hard token boundaries of one model.
 *
 * The AI layer is the single authority for these numbers. Agent context reserve,
 * tool output limits, pricing and run policy are *not* model limits and must
 * never be folded in here.
 */
export interface ModelLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

const LIMIT_KEYS = ["contextWindowTokens", "maxOutputTokens"] as const;

/**
 * Assert the frozen limit invariants:
 *
 * ```text
 * contextWindowTokens > 0
 * maxOutputTokens    > 0
 * maxOutputTokens    <= contextWindowTokens
 * ```
 */
export function assertModelLimits(value: unknown): asserts value is ModelLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model limits must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, LIMIT_KEYS, "Model limits");

  assertPositiveSafeInteger(candidate.contextWindowTokens, "Model limits contextWindowTokens");
  assertPositiveSafeInteger(candidate.maxOutputTokens, "Model limits maxOutputTokens");

  if ((candidate.maxOutputTokens as number) > (candidate.contextWindowTokens as number)) {
    throw new TypeError(
      `Model limits maxOutputTokens (${String(candidate.maxOutputTokens)}) must not exceed contextWindowTokens (${String(candidate.contextWindowTokens)}).`,
    );
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(
      `${label} must be a positive safe integer, received ${describeValue(value)}.`,
    );
  }
}
