import type { CompletionGateDecision } from "@caelush/agent";

import type { CompletionGateObservation } from "./run-completion-observation.js";

/**
 * The production completion effect settlement router.
 *
 * ```text
 * one executed completion effect -> exactly one settlement authority
 * ```
 *
 * The frozen `RunTransitionPlanner` can already plan two of the four completion decisions —
 * `ACCEPT` and `REJECT` — as ordinary transitions, and it refuses the other two on purpose:
 *
 * ```text
 * COMPLETION REPAIR                     needs a failed plan identity, failed check identities and
 *                                       evidence identities the frozen repair request does not carry
 * COMPLETION ERROR (retryable)          needs a retry schedule no durable continuation expresses
 * ```
 *
 * This router is the boundary that decides *which* authority settles a completion effect, and it is
 * deliberately the only place that decides it:
 *
 * ```text
 * CANONICAL_ACCEPT          the frozen planner completes the Run with the verified result
 * CANONICAL_REJECT          the frozen planner fails the Run with the gate's own error
 * REPAIR_COMPATIBILITY      the durable WAITING_VERIFICATION_REPAIR boundary, from the observation
 * RETRYABLE_ERROR_SUSPEND   the Run stays on its durable AWAITING_VERIFICATION boundary
 * TERMINATION_AUTHORITY     cancellation or a deadline, which own their own settlement
 * ```
 *
 * **Classification is by typed discriminant only.** No branch of this file reads an error message, a
 * status string or a gate id: a router that guessed from text would be a second authority over the
 * lifecycle, and it would keep guessing after the text changed.
 *
 * **There is no generic fallback.** A canonical branch is planned by the planner or it fails loudly; a
 * planner error is never caught and turned into a compatibility settlement, because that would leave
 * two authorities able to settle one effect with nothing recording which of them did.
 */

/** What settles one executed completion effect. */
export type CompletionEffectSettlementRoute =
  | {
      readonly route: "CANONICAL_ACCEPT";
      readonly decision: Extract<CompletionGateDecision, { kind: "ACCEPT" }>;
    }
  | {
      readonly route: "CANONICAL_REJECT";
      readonly decision: Extract<CompletionGateDecision, { kind: "REJECT" }>;
    }
  | {
      readonly route: "REPAIR_COMPATIBILITY";
      readonly decision: Extract<CompletionGateDecision, { kind: "REPAIR" }>;
      /**
       * The exact durable provenance the repair boundary persists.
       *
       * It comes from the Core-private observation, which read it from the durable verification
       * execution — never from the frozen repair request's `metadata`, which is a host description
       * rather than an authority over which checks failed.
       */
      readonly failedCheckIds: readonly import("@caelush/protocol").VerificationCheckId[];
      readonly errorCheckIds: readonly import("@caelush/protocol").VerificationCheckId[];
      readonly evidenceIds: readonly import("@caelush/protocol").VerificationEvidenceId[];
      readonly repairCycle: number;
    }
  | {
      readonly route: "RETRYABLE_ERROR_SUSPEND";
      readonly error: import("@caelush/protocol").AgentError;
    }
  | { readonly route: "TERMINATION_AUTHORITY" };

export interface CompletionEffectSettlementInput {
  /** The exact frozen decision `CompletionGate.evaluate()` returned. */
  readonly decision: CompletionGateDecision;
  /** The Core-private record of what the completion evaluation actually did. */
  readonly observation: CompletionGateObservation;
  /**
   * Whether the Run's cancellation or deadline authority already owns this Run.
   *
   * Resolved by the Run Layer *before* it classifies, because termination is a Run fact rather than a
   * completion one: a cancelled Run must never be completed, and a completion decision that arrived
   * after the deadline must not resurrect it.
   */
  readonly terminationDecided: boolean;
}

/** Classify one executed completion effect onto exactly one settlement authority. */
export function classifyCompletionEffectSettlement(
  input: CompletionEffectSettlementInput,
): CompletionEffectSettlementRoute {
  // Cancellation and the deadline outrank every completion decision. A gate that answered ACCEPT for a
  // Run the termination authority has already claimed must not commit it, and a gate that answered
  // REJECT must not turn a cancellation into a failed Run.
  if (input.terminationDecided) return { route: "TERMINATION_AUTHORITY" };

  const { decision } = input;
  switch (decision.kind) {
    case "ACCEPT":
      // Planned by the frozen planner: Run COMPLETED with the accepted result, continuation cleared.
      // `run.completed` is materialized separately, and only because the observation carries the
      // verified result and its seal.
      return { route: "CANONICAL_ACCEPT", decision };
    case "REJECT":
      // Also planned by the frozen planner: the Run and its AgentState fail with the gate's error.
      return { route: "CANONICAL_REJECT", decision };
    case "REPAIR":
      // The frozen planner refuses this branch on purpose, and the durable continuation needs four
      // identities the frozen repair request does not carry. They come from the observation, which
      // read them from the durable verification execution.
      return {
        route: "REPAIR_COMPATIBILITY",
        decision,
        failedCheckIds: requireObservationField(input.observation.failedCheckIds, "failedCheckIds"),
        errorCheckIds: input.observation.errorCheckIds ?? [],
        evidenceIds: input.observation.evidenceIds ?? [],
        repairCycle: requireRepairCycle(input, decision),
      };
    case "ERROR":
      if (decision.retryable) {
        // ```text
        // the gate could not decide
        // ```
        //
        // The Run already holds exactly the boundary this outcome means: a durable
        // `AWAITING_VERIFICATION` with its plan and evidence intact. Nothing is committed, and the
        // settlement ends the current drive rather than asking the gate again — which is what keeps a
        // retryable completion error from becoming a busy loop.
        return { route: "RETRYABLE_ERROR_SUSPEND", error: decision.error };
      }
      // A non-retryable completion ERROR is a deterministic verification failure: the gate established
      // that it cannot decide and that another attempt would not change the answer. It settles exactly
      // like a rejection, through the same planner branch.
      return {
        route: "CANONICAL_REJECT",
        decision: { kind: "REJECT", error: decision.error },
      };
    default:
      return assertNeverCompletionDecision(decision);
  }
}

/**
 * The repair cycle a `REPAIR` settlement persists.
 *
 * A missing cycle is a routing failure rather than a default: the cycle is what bounds a Run's repair
 * attempts, and inventing one would let a Run repair forever.
 */
function requireRepairCycle(
  input: CompletionEffectSettlementInput,
  decision: Extract<CompletionGateDecision, { kind: "REPAIR" }>,
): number {
  const cycle = input.observation.repairCycle ?? decision.repair.cycle;
  if (!Number.isSafeInteger(cycle) || cycle < 0) {
    throw new TypeError("A completion REPAIR requires the repair cycle the gate decided under.");
  }
  return cycle;
}
/** A durable identity the repair boundary cannot be written without. */
function requireObservationField<T>(value: readonly T[] | undefined, field: string): readonly T[] {
  if (value === undefined) {
    throw new TypeError(
      `A completion REPAIR requires the ${field} the gate read from durable verification evidence.`,
    );
  }
  return value;
}

/** Exhaustiveness guard: a new discriminant must break the build rather than lose a settlement. */
function assertNeverCompletionDecision(decision: never): never {
  throw new TypeError(
    `Unhandled completion decision: ${JSON.stringify((decision as { kind?: unknown }).kind)}`,
  );
}
