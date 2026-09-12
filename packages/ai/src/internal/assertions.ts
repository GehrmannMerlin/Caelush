/**
 * Internal, non-public assertion helpers.
 *
 * These produce plain `TypeError`s for shape violations. Runtime AI failures are
 * always expressed as `AIError`; a `TypeError` here means "a caller handed the AI
 * core a value of the wrong shape", which is a programming/configuration error
 * rather than something a model invocation can recover from.
 *
 * This module is deliberately not re-exported from the package root.
 */

/** Render a value for an assertion message without leaking object contents. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "object") return "an object";
  return String(value);
}

/** Assert an exact own-key set, so unknown fields can never be smuggled through. */
export function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${label} must not contain the unknown field "${key}".`);
    }
  }
}

/** Assert a non-empty string. */
export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string, received ${describeValue(value)}.`);
  }
}

/** Assert a strict boolean. */
export function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean, received ${describeValue(value)}.`);
  }
}

/** Assert a plain object (not an array, not null). */
export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object, received ${describeValue(value)}.`);
  }
}
