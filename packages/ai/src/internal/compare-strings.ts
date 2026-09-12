/** Deterministic code-unit string comparison, independent of locale. */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
