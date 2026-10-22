import type { EffectReconciliationPort } from "@caelush/agent";
import type { RuntimeResolver } from "@caelush/runtime";

import { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";

/**
 * Reconcile only side effects whose requested postcondition Runtime can inspect without writing.
 * Arbitrary commands and managed process interactions remain unsupported because a health check
 * cannot prove that a particular historical command produced the observed state.
 */
export function createRuntimeEffectReconciliationPort(
  resolver: RuntimeResolver,
): EffectReconciliationPort {
  return Object.freeze({
    async reconcile(
      input: Parameters<EffectReconciliationPort["reconcile"]>[0],
    ): ReturnType<EffectReconciliationPort["reconcile"]> {
      if (input.invocation.toolName !== "apply_patch") return { kind: "UNSUPPORTED" as const };
      const patch = input.invocation.args.patch;
      if (typeof patch !== "string" || patch.length === 0) {
        return { kind: "UNSUPPORTED" as const };
      }
      try {
        const scope = await resolveRuntimeWorkspace(resolver, input.environment, {
          securityContext: input.securityContext,
        });
        const result = await scope.patch.reconcile({ patch, signal: input.signal });
        return result;
      } catch {
        // An unavailable runtime or denied/read-failed inspection is not a negative proof.
        return { kind: "INCONCLUSIVE" as const };
      }
    },
  });
}
