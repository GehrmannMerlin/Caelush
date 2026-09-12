/**
 * Provider-independent reasoning effort levels.
 *
 * These are semantic levels, not provider controls. `reasoning_effort`,
 * `budget_tokens`, `thinkingConfig` and similar provider spellings are the
 * adapter's business only; they must never appear in an AI core request.
 */
export type ReasoningLevel = "OFF" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

/** The frozen canonical order, weakest to strongest. */
export const REASONING_LEVELS = [
  "OFF",
  "MINIMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
  "XHIGH",
] as const satisfies readonly ReasoningLevel[];

/** True when the value is one of the frozen reasoning levels. */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Canonical rank of a reasoning level: `OFF` is 0 and `XHIGH` is 5.
 *
 * Returns `undefined` for anything that is not a frozen level, so a caller can
 * never treat an unknown level as `OFF`.
 */
export function reasoningLevelIndex(value: unknown): number | undefined {
  const index = (REASONING_LEVELS as readonly string[]).indexOf(value as string);
  return index === -1 ? undefined : index;
}

/** Compare two reasoning levels by canonical rank, or `undefined` if either is unknown. */
export function compareReasoningLevels(left: unknown, right: unknown): number | undefined {
  const leftIndex = reasoningLevelIndex(left);
  const rightIndex = reasoningLevelIndex(right);
  if (leftIndex === undefined || rightIndex === undefined) return undefined;
  return leftIndex - rightIndex;
}

/**
 * Check a level list for the two frozen list invariants: uniqueness and
 * canonical order.
 */
export function isCanonicalReasoningLevelList(value: unknown): value is readonly ReasoningLevel[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  let previous = -1;

  for (const level of value) {
    const index = reasoningLevelIndex(level);
    if (index === undefined) return false;
    if (seen.has(level as string)) return false;
    if (index <= previous) return false;
    seen.add(level as string);
    previous = index;
  }
  return true;
}
