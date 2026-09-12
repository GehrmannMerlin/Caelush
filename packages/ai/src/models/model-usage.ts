import { assertExactKeys, describeValue } from "../internal/assertions.js";

/**
 * Token accounting for one model turn.
 *
 * Every field is optional: a provider may report nothing, a partial snapshot, or
 * a full one. `cachedInputTokens` and `reasoningTokens` are subsets of the
 * corresponding totals, never additional totals.
 */
export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** Every usage field, in canonical order. */
export const MODEL_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof ModelUsage)[];

/** Assert a well-formed usage snapshot. `undefined` is a valid "no usage yet". */
export function assertModelUsage(value: unknown): asserts value is ModelUsage {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model usage must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, MODEL_USAGE_FIELDS, "Model usage");

  for (const field of MODEL_USAGE_FIELDS) {
    const count = candidate[field];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new TypeError(
        `Model usage ${field} must be a non-negative safe integer, received ${describeValue(count)}.`,
      );
    }
  }
}

/**
 * Copy a usage snapshot down to the frozen fields.
 *
 * A provider adapter may hand over a wider object; only the frozen counters may
 * reach the AI core's public contracts.
 */
export function normalizeModelUsage(value: ModelUsage | undefined): ModelUsage | undefined {
  if (value === undefined) return undefined;
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  } = {};

  for (const field of MODEL_USAGE_FIELDS) {
    const count = value[field];
    if (count !== undefined) usage[field] = count;
  }
  return usage;
}
