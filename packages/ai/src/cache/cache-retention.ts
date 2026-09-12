/**
 * Prompt cache retention.
 *
 * A semantic retention class, not a provider cache control field. `SHORT` and
 * `LONG` express "how long should the provider keep this" without naming a
 * provider mechanism.
 */
export type CacheRetention = "NONE" | "SHORT" | "LONG";

/** The frozen retention order, weakest to strongest. */
export const CACHE_RETENTIONS = [
  "NONE",
  "SHORT",
  "LONG",
] as const satisfies readonly CacheRetention[];

/** True when the value is one of the frozen retentions. */
export function isCacheRetention(value: unknown): value is CacheRetention {
  return typeof value === "string" && (CACHE_RETENTIONS as readonly string[]).includes(value);
}

/** Canonical rank of a retention: `NONE` is 0 and `LONG` is 2. */
export function cacheRetentionIndex(value: unknown): number | undefined {
  const index = (CACHE_RETENTIONS as readonly string[]).indexOf(value as string);
  return index === -1 ? undefined : index;
}

/** Check a retention list for uniqueness and canonical order. */
export function isCanonicalCacheRetentionList(value: unknown): value is readonly CacheRetention[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  let previous = -1;

  for (const retention of value) {
    const index = cacheRetentionIndex(retention);
    if (index === undefined) return false;
    if (seen.has(retention as string)) return false;
    if (index <= previous) return false;
    seen.add(retention as string);
    previous = index;
  }
  return true;
}
