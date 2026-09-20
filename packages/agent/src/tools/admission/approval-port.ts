import type { ApprovalRequest, ApprovalScope, RunId, ToolInvocationId } from "@caelush/protocol";

import type { ToolApprovalRequirement } from "./admission-decision.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import type { PreparedToolCall } from "../call/tool-call-preparer.js";

/**
 * The durable approval lookup an admission coordinator needs.
 *
 * ```ts
 * export interface ToolApprovalLookupPort {
 *   getByInvocation(toolInvocationId): Promise<ApprovalRequest | null>;
 *   getStoredApprovalKey(toolInvocationId): Promise<string | null>;
 *   findApplicableRunGrant(input: { runId, approvalKey }): Promise<ApprovalRequest | null>;
 * }
 * ```
 *
 * Three questions, and deliberately no fourth:
 *
 * ```text
 * getByInvocation          what did we already durably ask about this invocation?
 * getStoredApprovalKey     what identity was that request created under?
 * findApplicableRunGrant   does an APPROVED, RUN-scoped grant already cover this exact key?
 * ```
 *
 * ## What is *not* here
 *
 * Creating an approval is not a method on this port. A durable `ApprovalRequest` is created as part of
 * one atomic Tool execution commit — together with the `WAITING_APPROVAL` invocation, the invocation's
 * approval key and the `approval.requested` event — because an approval that exists while its
 * invocation does not (or the reverse) is a durable state no recovery can interpret:
 *
 * ```text
 * forbidden   INSERT approval_requests; then, in another transaction, UPDATE tool_invocations
 * required    one ToolExecutionStorePort.commit carrying invocation + approval + key + event
 * ```
 *
 * ## What stays in Storage
 *
 * Resolution, lazy expiry, listing and cancellation are approval-workflow operations owned by the
 * host's approval repository and its UI/HTTP surface. They are not admission questions and are not
 * widened into this port.
 */
export interface ToolApprovalLookupPort {
  getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null>;

  /**
   * The identity a stored approval was created under.
   *
   * ```text
   * string        the stored identity, to be compared against the recomputed one
   * null          no approval identity is stored for this invocation
   * undefined     this host cannot answer the question at all
   * ```
   *
   * The third case is not the second. `null` is a comparison the caller can make; `undefined` says the
   * host has no way to read the identity, so no comparison is possible. Reading the absent answer as a
   * match would make a missing lookup a silent pass, and reading it as a mismatch would refuse a call
   * the host simply cannot describe — so it is reported as its own fact and the caller decides.
   */
  getStoredApprovalKey(toolInvocationId: ToolInvocationId): Promise<string | null | undefined>;

  /**
   * The newest `APPROVED`, `RUN`-scoped grant for this exact key in this exact Run, or `null`.
   *
   * There is no name-only, wildcard, cross-Run or prefix match. A grant is valid only for the identity
   * it was resolved under.
   */
  findApplicableRunGrant(input: {
    readonly runId: RunId;
    readonly approvalKey: string;
  }): Promise<ApprovalRequest | null>;
}

/**
 * How a durable `ApprovalRequest` is built for one approval requirement.
 *
 * ## Why this is injected rather than declared on the frozen requirement
 *
 * The frozen `ToolApprovalRequirement` carries an opaque key, a safe reason and an optional scope.
 * A production `ApprovalRequest` carries more presentation than that — a risk level, a title, and a
 * redacted action preview describing the shell command or structural change being approved. Those are
 * Coding/Security presentation facts.
 *
 * Widening the general requirement so it could carry them would put a Coding presentation model into
 * every general Agent host's admission contract. Injecting the builder keeps the contract narrow and
 * keeps the approval card exactly as rich as it is today:
 *
 * ```text
 * Agent admission coordinator   decides THAT approval is required, and holds the invocation
 * host approval factory         decides how the request presents, from its own security facts
 * ```
 *
 * A factory that returns `null` means the host cannot durably express this requirement. That is not a
 * reason to run the Tool: the coordinator fails closed with an `ADMISSION` infrastructure failure.
 */
export type ToolApprovalRequestFactory = (input: {
  readonly identity: ToolExecutionIdentity;
  readonly call: PreparedToolCall;
  readonly requirement: ToolApprovalRequirement;
  readonly createdAt: import("@caelush/protocol").TimestampMs;
}) => ApprovalRequest | null | Promise<ApprovalRequest | null>;

/** The scope a requirement grants when the admission implementation did not state one. */
export const DEFAULT_TOOL_APPROVAL_SCOPE: ApprovalScope = "RUN";
