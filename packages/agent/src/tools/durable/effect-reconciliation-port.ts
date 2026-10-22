import type { RunId, ToolInvocation } from "@caelush/protocol";

import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolSecurityContext } from "../admission/security-context.js";

/**
 * A host-owned, read-only check for a side effect whose handler crossed the durable RUNNING boundary
 * but whose result did not commit. A match describes the current target state only; it never proves
 * which process produced it and never changes the original invocation or observation.
 */
export interface EffectReconciliationPort {
  reconcile(input: {
    readonly runId: RunId;
    readonly invocation: ToolInvocation;
    readonly environment: ToolExecutionEnvironment;
    readonly securityContext: ToolSecurityContext;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: "MATCHED_EXPECTED_STATE" }
    | { readonly kind: "DOES_NOT_MATCH" }
    | { readonly kind: "INCONCLUSIVE" }
    | { readonly kind: "UNSUPPORTED" }
  >;
}
