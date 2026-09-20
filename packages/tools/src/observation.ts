/**
 * The legacy Tool observation entry point.
 *
 * ```text
 * Phase 4C moved the canonical factory and invariant to @caelush/agent
 * this module re-exports them
 * ```
 *
 * An observation is a function of the invocation it belongs to, and the coordinator that commits the
 * invocation is what has to enforce that. Keeping a second factory here would let two layers build two
 * accounts of one execution.
 */
export { assertToolObservationInvariant, createToolObservation } from "@caelush/agent";
export type { CreateToolObservationInput } from "@caelush/agent";
