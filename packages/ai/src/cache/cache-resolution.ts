import type { CacheRetention } from "./cache-retention.js";

/** A caller's prompt cache request. */
export interface AICacheRequest {
  readonly retention: CacheRetention;
  readonly key?: string;
}

/**
 * How a cache request was settled.
 *
 * Unlike reasoning, an unsupported cache request is never a failure: it is
 * downgraded. Caching is an optimisation, and losing it must not lose the model
 * call.
 */
export interface CacheResolution {
  readonly requested: CacheRetention;
  readonly effective: CacheRetention;
  readonly mode: "EXACT" | "DOWNGRADED";
  readonly key?: string;
}

/** Every cache resolution mode. */
export const CACHE_RESOLUTION_MODES = [
  "EXACT",
  "DOWNGRADED",
] as const satisfies readonly CacheResolution["mode"][];
