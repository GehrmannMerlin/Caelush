import { createAIError } from "../errors/ai-error.js";
import { compareStrings } from "../internal/compare-strings.js";
import type { ApiAdapter } from "./api-adapter.js";
import type { ApiId } from "../ids/api-id.js";

/**
 * The immutable registry of API dialects.
 *
 * Keyed by `ApiId`, not by provider: one adapter serves every provider that
 * speaks its dialect. This is the mechanism behind `Model != Provider != API
 * dialect`.
 */
export interface ApiAdapterRegistry {
  /** The adapter for a dialect; throws `AI_ADAPTER_NOT_FOUND` when absent. */
  get(api: ApiId): ApiAdapter;
  has(api: ApiId): boolean;
  /** Registered dialect ids, sorted. */
  listIds(): readonly ApiId[];
}

/** The runtime implementation. Constructed only through the builder. */
export class ImmutableApiAdapterRegistry implements ApiAdapterRegistry {
  readonly #adapters: ReadonlyMap<ApiId, ApiAdapter>;
  readonly #ids: readonly ApiId[];

  constructor(adapters: ReadonlyMap<ApiId, ApiAdapter>) {
    this.#adapters = adapters;
    this.#ids = Object.freeze([...adapters.keys()].sort(compareStrings));
    Object.freeze(this);
  }

  get(api: ApiId): ApiAdapter {
    const adapter = this.#adapters.get(api);
    if (adapter === undefined) {
      throw createAIError(
        "AI_ADAPTER_NOT_FOUND",
        `No API adapter is registered for the dialect "${api}".`,
      );
    }
    return adapter;
  }

  has(api: ApiId): boolean {
    return this.#adapters.has(api);
  }

  listIds(): readonly ApiId[] {
    return this.#ids;
  }
}
