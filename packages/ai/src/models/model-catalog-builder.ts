import { assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { collectCatalogDescriptors, ImmutableModelCatalog } from "./model-catalog.js";
import type { ModelCatalog } from "./model-catalog.js";
import type { ModelDescriptorSourcePort } from "./model-descriptor-source-port.js";

/**
 * Builds a runtime {@link ModelCatalog}.
 *
 * The builder is mutable; the catalog it produces is not. Once `build()` has
 * returned, the builder refuses both further registration and a second build, so
 * a catalog can never be extended behind a caller's back.
 */
export interface ModelCatalogBuilder {
  registerSource(source: ModelDescriptorSourcePort): this;
  build(): ModelCatalog;
}

/** Create an empty catalog builder. */
export function createModelCatalogBuilder(): ModelCatalogBuilder {
  const sources: ModelDescriptorSourcePort[] = [];
  const ids = new Set<string>();
  let built = false;

  const assertNotBuilt = (operation: string): void => {
    if (built) {
      throw new TypeError(`Model catalog builder cannot ${operation} after build().`);
    }
  };

  return {
    registerSource(source: ModelDescriptorSourcePort): ModelCatalogBuilder {
      assertNotBuilt("register a source");

      if (typeof source !== "object" || source === null) {
        throw new TypeError(
          `Model descriptor source must be an object, received ${describeValue(source)}.`,
        );
      }
      assertNonEmptyString(source.id, "Model descriptor source id");
      if (!Number.isSafeInteger(source.priority) || source.priority < 0) {
        throw new TypeError(
          `Model descriptor source "${source.id}" priority must be a non-negative safe integer, received ${describeValue(source.priority)}.`,
        );
      }
      if (typeof source.resolve !== "function") {
        throw new TypeError(`Model descriptor source "${source.id}" must implement resolve().`);
      }
      if (ids.has(source.id)) {
        throw new TypeError(`Model descriptor source "${source.id}" is already registered.`);
      }

      ids.add(source.id);
      sources.push(source);
      return this;
    },

    build(): ModelCatalog {
      assertNotBuilt("build twice");
      built = true;

      // Enumerable sources are validated and snapshotted here, so a defective
      // source fails at composition time rather than at first model invocation.
      const descriptors = collectCatalogDescriptors(sources);
      return new ImmutableModelCatalog(sources, descriptors);
    },
  };
}
