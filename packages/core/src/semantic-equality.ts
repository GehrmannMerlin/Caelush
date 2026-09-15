/**
 * Structural equality for durable protocol values.
 *
 * Key order is not part of a tool call's identity, and two projections of the same turn carry
 * nominally different JSON types, so the comparison is by structure rather than by reference or by
 * serialized text. It is deliberately not a deep-equal over arbitrary objects: arrays compare
 * positionally and records compare by their sorted key sets, which is exactly what a persisted
 * decision and a durable message need in order to be agreed on.
 *
 * It lives in its own module so the Run Layer's compatibility recovery and the Tool turn adapter
 * compare identities the same way instead of each owning a private opinion about when two records
 * are the same record.
 */
export function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && semanticEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
