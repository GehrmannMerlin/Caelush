/**
 * The legacy Tool invocation lifecycle entry point.
 *
 * ```text
 * Phase 4C moved the canonical transition table to @caelush/agent
 * this module re-exports it
 * ```
 *
 * The lifecycle is the *decision* a durable coordinator makes, so it belongs with the store contract
 * and the coordinator that commit it. There is exactly one transition table in the repository; a
 * second copy here would eventually disagree with the canonical one, and the disagreement would be
 * about which durable states a Tool call may occupy.
 *
 * The one intentional semantic difference from the pre-4C legacy module: an invalid transition now
 * throws `ToolExecutionInvariantError` (the canonical durable error) rather than a bare `Error`. No
 * production path relied on the bare type, and the canonical class is what a durable invariant failure
 * should be caught as.
 */
export {
  allowedToolInvocationTransitions,
  assertToolInvocationInvariant,
  assertToolInvocationTransition,
  completeToolInvocation,
  createRequestedToolInvocation,
  failToolInvocation,
  isTerminalToolInvocation,
  markToolInvocationWaitingApproval,
  startToolInvocation,
} from "@caelush/agent";
export type { CreateRequestedToolInvocationInput } from "@caelush/agent";

export { assertToolObservationInvariant, createToolObservation } from "@caelush/agent";
export type { CreateToolObservationInput } from "@caelush/agent";
