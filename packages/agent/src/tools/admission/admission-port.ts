import type { ToolCallRequest } from "../call/tool-call-preparer.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import type { ToolAdmissionRequest } from "./admission-decision.js";
import type { ToolPolicyDecision } from "./admission-decision.js";
import type { ToolAdmissionEvaluationContext } from "./admission-coordinator.js";

/**
 * The policy evaluation boundary.
 *
 * ```ts
 * export interface ToolAdmissionPort {
 *   evaluate(request: ToolAdmissionRequest): Promise<ToolPolicyDecision>;
 * }
 * ```
 *
 * ## What is on either side of it
 *
 * ```text
 * @caelush/agent        declares this port and consumes it
 * Security / Coding     implements it
 * ```
 *
 * Phase 9A's `CaelushToolExecutionGate` is **not** moved into the Agent layer by this contract. The
 * existing gate keeps its `ToolExecutionGateInput` — an invocation, a legacy `ToolDefinition`, a
 * runtime kind and Coding security facts — and a Security/Coding **admission adapter** implements this
 * narrower port on top of it. The Agent layer therefore sees a policy decision and nothing about how
 * it was reached.
 *
 * ## Failure is a throw
 *
 * An implementation that cannot evaluate must throw. Returning `ALLOW` because facts could not be
 * projected, a catalog entry was missing, or a policy invariant broke would turn every one of those
 * into silent authorization. Returning `DENY` for all of them would be safe but would misreport a
 * broken evaluator as a policy decision, so the two are kept apart: a broken evaluator is an
 * infrastructure failure, and a refusal is a decision.
 */
export interface ToolAdmissionPort {
  evaluate(
    request: ToolAdmissionRequest,
    evaluationContext?: ToolAdmissionEvaluationContext,
  ): Promise<ToolPolicyDecision>;
}

/**
 * The pre-check a host may place in front of policy evaluation.
 *
 * It exists so a host-specific, *bounded* short-circuit — the legacy Tool failure memory is the
 * production example — can refuse a call **inside** the canonical admission flow, rather than in
 * front of the durable coordinator. A short-circuit that ran outside would have to fabricate its own
 * durable failure row, which is exactly the second lifecycle implementation Phase 4C removes.
 *
 * A pre-check returns only what policy evaluation may return, minus `REQUIRE_APPROVAL`:
 *
 * ```text
 * undefined   no opinion, continue to the policy port
 * DENY        refused, with safe model-facing feedback
 * ```
 *
 * It is called **before** the policy port and before any budget side effect, so a refusal costs
 * nothing and leaves nothing.
 */
export interface ToolAdmissionPreCheck {
  check(request: ToolAdmissionRequest): ToolPolicyDecision | undefined;
}

/** The decision a pre-check may return. `REQUIRE_APPROVAL` is policy's, not a pre-check's. */
export type ToolAdmissionPreCheckDecision = Extract<ToolPolicyDecision, { kind: "DENY" }>;

/** The identity fields an admission request and a durable invocation must agree on. */
export type ToolAdmissionIdentity = ToolExecutionIdentity;

/** The call a pre-check may inspect, for a host that keyed its short-circuit on the prepared call. */
export type ToolAdmissionCallIdentity = Pick<
  ToolCallRequest,
  "externalCallId" | "toolName" | "args"
>;
