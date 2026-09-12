import { assertExactKeys, describeValue } from "../internal/assertions.js";
import { isCanonicalCacheRetentionList } from "../cache/cache-retention.js";
import type { CacheRetention } from "../cache/cache-retention.js";

/**
 * Which prompt cache retentions one model really offers.
 *
 * `supportedRetentions` must be unique and in canonical order so the cache
 * resolver can downgrade deterministically without re-sorting.
 */
export interface ModelCacheProfile {
  readonly supportedRetentions: readonly CacheRetention[];
  readonly defaultRetention?: CacheRetention;
}

const CACHE_PROFILE_KEYS = ["supportedRetentions", "defaultRetention"] as const;

/** Assert a well-formed cache profile. */
export function assertModelCacheProfile(value: unknown): asserts value is ModelCacheProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model cache profile must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, CACHE_PROFILE_KEYS, "Model cache profile");

  if (!isCanonicalCacheRetentionList(candidate.supportedRetentions)) {
    throw new TypeError(
      "Model cache profile supportedRetentions must be unique cache retentions in canonical order.",
    );
  }

  const defaultRetention = candidate.defaultRetention;
  if (defaultRetention === undefined) return;
  if (!(candidate.supportedRetentions as readonly string[]).includes(defaultRetention as string)) {
    throw new TypeError(
      `Model cache profile defaultRetention ${describeValue(defaultRetention)} must be one of supportedRetentions.`,
    );
  }
}
