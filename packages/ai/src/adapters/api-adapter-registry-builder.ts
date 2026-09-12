import { describeValue } from "../internal/assertions.js";
import { isValidApiId } from "../ids/api-id.js";
import { ImmutableApiAdapterRegistry } from "./api-adapter-registry.js";
import type { ApiAdapter } from "./api-adapter.js";
import type { ApiAdapterRegistry } from "./api-adapter-registry.js";
import type { ApiId } from "../ids/api-id.js";

/**
 * Builds a runtime {@link ApiAdapterRegistry}.
 *
 * A duplicate dialect id is a configuration error rather than a silent
 * overwrite: two adapters claiming one dialect would make routing depend on
 * registration order.
 */
export interface ApiAdapterRegistryBuilder {
  register(adapter: ApiAdapter): this;
  build(): ApiAdapterRegistry;
}

/** Create an empty adapter registry builder. */
export function createApiAdapterRegistryBuilder(): ApiAdapterRegistryBuilder {
  const adapters = new Map<ApiId, ApiAdapter>();
  let built = false;

  const assertNotBuilt = (operation: string): void => {
    if (built)
      throw new TypeError(`API adapter registry builder cannot ${operation} after build().`);
  };

  return {
    register(adapter: ApiAdapter): ApiAdapterRegistryBuilder {
      assertNotBuilt("register an adapter");

      if (typeof adapter !== "object" || adapter === null) {
        throw new TypeError(`API adapter must be an object, received ${describeValue(adapter)}.`);
      }
      if (typeof adapter.id !== "string" || !isValidApiId(adapter.id)) {
        throw new TypeError(
          `API adapter id must be a valid api id, received ${describeValue(adapter.id)}.`,
        );
      }
      if (typeof adapter.stream !== "function") {
        throw new TypeError(`API adapter "${adapter.id}" must implement stream().`);
      }
      if (adapters.has(adapter.id)) {
        throw new TypeError(`API adapter "${adapter.id}" is already registered.`);
      }

      adapters.set(adapter.id, adapter);
      return this;
    },

    build(): ApiAdapterRegistry {
      assertNotBuilt("build twice");
      built = true;
      return new ImmutableApiAdapterRegistry(new Map(adapters));
    },
  };
}
