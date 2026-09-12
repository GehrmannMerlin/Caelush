import type { ModelDescriptor } from "./model-descriptor.js";
import type { ModelRef } from "./model-ref.js";

/**
 * A source of model descriptors.
 *
 * This is the frozen three-member port. A source is a **pure lookup table**: it
 * may not perform a network request, read mutable environment, or behave
 * randomly while resolving. Discovery that needs I/O must happen before the
 * source is constructed, and the result is then frozen into it.
 *
 * `priority` breaks ties *inside* one descriptor source kind: lower wins. It can
 * never outrank the frozen `ModelDescriptor.source` precedence.
 */
export interface ModelDescriptorSourcePort {
  readonly id: string;
  readonly priority: number;
  resolve(ref: ModelRef): ModelDescriptor | undefined;
}

/**
 * A source that can also enumerate the descriptors it owns.
 *
 * `ModelCatalog.list()` and the subsystem startup checks need the known set, and
 * the frozen port has no enumeration member. Rather than widen the frozen
 * contract, enumeration is an additive capability: a resolve-only source keeps
 * working unchanged and simply contributes nothing to `list()`.
 *
 * Only sources with a fixed known set can implement this. A fallback source
 * describes whatever ref it is asked about, so it is never enumerable.
 */
export interface EnumerableModelDescriptorSourcePort extends ModelDescriptorSourcePort {
  list(): readonly ModelDescriptor[];
}

/** True when a source can enumerate its known descriptors. */
export function isEnumerableSource(
  source: ModelDescriptorSourcePort,
): source is EnumerableModelDescriptorSourcePort {
  return typeof (source as Partial<EnumerableModelDescriptorSourcePort>).list === "function";
}
