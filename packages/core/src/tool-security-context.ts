import type { ToolSecurityContext } from "@caelush/agent";
import type { AgentRun, AgentState } from "@caelush/protocol";

import { RunControllerInvariantError } from "./run-controller-errors.js";
import { createRunSecurityContext } from "./run-security-context.js";

/**
 * Project one Run's durable security policy onto the Tool Layer's security context.
 *
 * ```text
 * AgentRun.permissionProfile + AgentRun.approvalPolicy
 *        ↓
 * ToolSecurityContext
 * ```
 *
 * The Run is the authority and the AgentState must already agree with it: the two are written
 * together, so a disagreement means the ledger is inconsistent and the Tool boundary fails closed
 * rather than choosing one of them. The context is derived from durable Run policy, never from
 * model arguments or Tool arguments, and the projection is frozen so a Tool handler cannot widen
 * the policy it was admitted under.
 *
 * It lives in its own module because two boundaries now need it — the Run Layer's Tool turn
 * adapter and the RunController's own security seams — and a second copy would be a second
 * authority over what a Run is allowed to do.
 */
export function createToolSecurityContext(
  run: AgentRun,
  state: Pick<AgentState, "permissionProfile" | "approvalPolicy">,
): ToolSecurityContext {
  const security = createRunSecurityContext(run.securityPolicy);
  if (
    security.permissionProfile !== state.permissionProfile ||
    security.approvalPolicy !== state.approvalPolicy
  ) {
    throw new RunControllerInvariantError("Run security policy does not match AgentState policy.");
  }
  return Object.freeze({
    permissionProfile: security.permissionProfile,
    approvalPolicy: security.approvalPolicy,
    securityPolicy: Object.freeze({
      presetId: security.presetId,
      presetVersion: security.presetVersion,
      policyDigest: security.policyDigest,
      filesystemBoundary: security.filesystemBoundary,
      processBoundary: security.processBoundary,
      requiredEnforcement: security.requiredEnforcement,
    }),
  });
}
