import type { RuntimeResolver } from "@caelush/runtime";

import type { PatchOperations } from "../operations.js";
import { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";

/**
 * The Runtime implementation of `PatchOperations`.
 *
 * ```text
 * patch document in  →  the whole Runtime patch pipeline  →  change count + per-change summary
 * ```
 *
 * Parse, plan, prepare, guard-all, commit sequentially and verify all belong to the Runtime. This
 * adapter contributes the workspace binding and the result shape, and nothing else.
 *
 * ## Uncertainty is deliberately not translated here
 *
 * A patch is the one Coding operation whose side effect can be unprovable: the commit may have partially
 * applied, or the rollback may itself have failed. The Runtime raises `RuntimePatchUncertainError` for
 * that case, and this adapter lets it through **untouched** — it does not catch it, does not wrap it, and
 * does not turn it into a returned failure.
 *
 * The mapping onto the canonical uncertain-side-effect vocabulary happens one layer out, at the Coding
 * Tool boundary, which is the layer that also owns the decision to stop a Tool batch. Translating it
 * here into an ordinary result would be exactly the "swallow the uncertain patch" failure the freeze
 * calls out by name: the model would be told the patch failed, and would patch again.
 */
export function createRuntimePatchOperations(resolver: RuntimeResolver): PatchOperations {
  return {
    async apply(input) {
      const scope = await resolveRuntimeWorkspace(resolver, input.environment);
      const result = await scope.patch.apply({ patch: input.patch, signal: input.signal });
      return {
        changeCount: result.changeCount,
        changes: result.changes.map((change) => ({ ...change })),
      };
    },
  };
}
