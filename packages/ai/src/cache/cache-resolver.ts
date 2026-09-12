import { assertModelDescriptor } from "../models/model-descriptor.js";
import { CACHE_RETENTIONS, cacheRetentionIndex, isCacheRetention } from "./cache-retention.js";
import type { CacheRetention } from "./cache-retention.js";
import type { AICacheRequest, CacheResolution } from "./cache-resolution.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";

/** Input for one cache resolution. */
export interface CacheResolverInput {
  readonly request?: AICacheRequest;
  readonly model: ModelDescriptor;
}

/**
 * Settles a cache request against a model's real retentions.
 *
 * Pure and deterministic. It can only ever downgrade: a model that does not
 * support the requested retention gets a weaker one, never a stronger one.
 */
export interface CacheResolver {
  resolve(input: CacheResolverInput): CacheResolution;
}

/** The default, stateless cache resolver. */
export function createCacheResolver(): CacheResolver {
  return {
    resolve(input: CacheResolverInput): CacheResolution {
      const { request, model } = input;
      assertModelDescriptor(model);

      if (request === undefined) {
        return { requested: "NONE", effective: "NONE", mode: "EXACT" };
      }
      if (!isCacheRetention(request.retention)) {
        throw new TypeError(`Cache request retention is unknown: ${String(request.retention)}.`);
      }

      const supported = model.cache?.supportedRetentions ?? [];
      const requestedIndex = cacheRetentionIndex(request.retention);
      if (requestedIndex === undefined) {
        throw new TypeError(`Cache request retention is unknown: ${String(request.retention)}.`);
      }

      const effective = downgrade(supported, requestedIndex);
      const resolved: {
        requested: CacheRetention;
        effective: CacheRetention;
        mode: CacheResolution["mode"];
        key?: string;
      } = {
        requested: request.retention,
        effective,
        mode: effective === request.retention ? "EXACT" : "DOWNGRADED",
      };

      // A caller-supplied key is always preserved, so the resolution stays a
      // faithful projection of what was requested as well as what was decided.
      if (request.key !== undefined) resolved.key = request.key;

      return resolved;
    },
  };
}

/**
 * Walk downward from the requested retention.
 *
 * Only `LONG → SHORT → NONE` is ever traversed. `SHORT → LONG` and
 * `NONE → SHORT` are unreachable by construction, because the walk starts at the
 * requested rank and only decreases.
 */
function downgrade(supported: readonly CacheRetention[], requestedIndex: number): CacheRetention {
  for (let index = requestedIndex; index >= 0; index -= 1) {
    const candidate = CACHE_RETENTIONS[index];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  return "NONE";
}
