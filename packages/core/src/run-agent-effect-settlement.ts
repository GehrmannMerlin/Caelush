import type { AdvanceAgentDirective, AgentLoopAdvanceResult } from "@caelush/agent";

import type { AgentTurnObservation } from "./run-model-turn-boundary.js";

/**
 * The production Agent effect settlement router.
 *
 * ```text
 * one executed Agent effect -> exactly one settlement authority
 * ```
 *
 * Phase 3C made the Run transition planner the authority for the transitions it can express. This
 * is the boundary that decides *which* authority settles an Agent effect, and it is deliberately
 * the only place that decides it:
 *
 * ```text
 * CANONICAL_AGENT_EFFECT        the frozen planner plans the commit; no manual transition remains
 * VERIFICATION_COMPATIBILITY    the legacy FinalCandidate -> VerificationPlan bridge
 * RETRY_COMPATIBILITY           the legacy Run Retry Policy bridge
 * TERMINATION_AUTHORITY         cancellation and death, which own their own atomic cleanup
 * BUDGET_AUTHORITY              a durable budget refusal, which owns its own accounting
 * ```
 *
 * It consumes the **frozen** `AgentLoopAdvanceResult` directly. Phase 3C checkpoint 6 replaced the
 * legacy `AgentLoopExecutionResult` this router used to classify, so there is no compatibility
 * projection in the production Agent path any more: the object `advance()` returned is the object
 * the planner plans from.
 *
 * **Classification is by typed discriminant only.** No branch of this file reads an error message,
 * a status string or a provider code: a router that guessed from text would be a second authority
 * over the lifecycle, and it would keep guessing after the text changed.
 *
 * **There is no generic fallback.** A canonical branch is planned by the planner or it fails loudly;
 * a planner error is never caught and turned into a legacy settlement, because that would leave two
 * authorities able to settle one effect and no way to tell which one did.
 */

/** What settles one executed Agent effect. */
export type AgentEffectSettlementRoute =
  | {
      readonly route: "CANONICAL_AGENT_EFFECT";
      /** The coordinator's own decision, which is the planner's directive authority. */
      readonly directive: AdvanceAgentDirective;
      /** The exact frozen result the kernel returned. */
      readonly result: AgentLoopAdvanceResult;
    }
  | { readonly route: "VERIFICATION_COMPATIBILITY" }
  | { readonly route: "RETRY_COMPATIBILITY" }
  | { readonly route: "TERMINATION_AUTHORITY" }
  | { readonly route: "BUDGET_AUTHORITY" };

export interface AgentEffectSettlementInput {
  /** The exact frozen result `AgentLoop.advance()` returned. */
  readonly result: AgentLoopAdvanceResult;
  /**
   * The directive the coordinator produced for this effect.
   *
   * It is never optional in the production path: a Driver effect is only ever executed because the
   * coordinator decided on it, so a canonical Agent effect always has one. It stays a parameter
   * because the router must not be able to invent one, and because a `FINAL_CANDIDATE` is settled by
   * the verification bridge *instead of* the planner.
   */
  readonly directive: AdvanceAgentDirective;
  /**
   * The Core-private record of what the boundary, the Context Engine and the provider did.
   *
   * Two facts the frozen result deliberately does not carry are read from here, and from nowhere
   * else: whether a provider turn actually ran, and whether the admission authority refused the
   * turn with a durable block.
   */
  readonly observation: AgentTurnObservation;
}

/** Classify one executed Agent effect onto exactly one settlement authority. */
export function classifyAgentEffectSettlement(
  input: AgentEffectSettlementInput,
): AgentEffectSettlementRoute {
  const { result, directive, observation } = input;

  // A refusal by the budget authority owns its own accounting and its own terminal settlement. The
  // exact block the admission port returned is the authority — the frozen error is a projection of
  // it, and re-deriving the numbers from the projection would lose them.
  if (observation.admissionBlock !== undefined) return { route: "BUDGET_AUTHORITY" };

  // Cancellation is the termination authority's, whatever the kernel reported. Agent-level
  // cancellation means a Reason stopped; it does not mean the Run is cancelled, and the Run
  // Termination Authority decides what it means for the Run.
  if (result.kind === "CANCELLED") return { route: "TERMINATION_AUTHORITY" };

  if (result.kind === "FINAL_CANDIDATE") {
    // Completion authority is Phase 3E. Until then the legacy verification bridge owns it, and the
    // planner's own FINAL_CANDIDATE branch stays fail-closed rather than being used as a fallback.
    return { route: "VERIFICATION_COMPATIBILITY" };
  }

  if (result.kind === "FAILED" && result.retry?.retryable === true) {
    // A retry needs an attempt number and a next attempt time the planner does not have. The Run
    // Retry Policy owns that decision; the planner must not invent a schedule.
    return { route: "RETRY_COMPATIBILITY" };
  }

  // Everything else the frozen contract can express — TOOL_REQUESTS and a non-retryable FAILED —
  // is a transition the pure planner plans. A cancellation is deliberately *not* among them: it is
  // the termination authority's, and the planner must not become a second cancellation authority.
  return { route: "CANONICAL_AGENT_EFFECT", directive, result };
}
