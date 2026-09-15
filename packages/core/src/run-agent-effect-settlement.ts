import type { AdvanceAgentDirective, AgentLoopAdvanceResult } from "@caelush/agent";
import type { AgentLoopExecutionResult } from "./agent-loop-input.js";

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
 * COMPATIBILITY                 every outcome with no frozen result behind it
 * ```
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
  | { readonly route: "BUDGET_AUTHORITY" }
  | { readonly route: "COMPATIBILITY" };

export interface AgentEffectSettlementInput {
  readonly execution: AgentLoopExecutionResult;
  /**
   * The directive the coordinator produced for this effect, when it produced one.
   *
   * Absent means the durable state this effect ran against has no routable advance decision — the
   * epoch-specific compatibility path reached a state the coordinator would not have routed. It is
   * never a reason to guess a directive: the effect is settled by the compatibility authority.
   */
  readonly directive: AdvanceAgentDirective | undefined;
}

/** Classify one executed Agent effect onto exactly one settlement authority. */
export function classifyAgentEffectSettlement(
  input: AgentEffectSettlementInput,
): AgentEffectSettlementRoute {
  const { execution, directive } = input;

  // Cancellation is the termination authority's, whatever the kernel reported. Agent-level
  // cancellation means a Reason stopped; it does not mean the Run is cancelled.
  if (execution.status === "CANCELLED") return { route: "TERMINATION_AUTHORITY" };

  // A durable budget refusal owns its own accounting and its own terminal settlement.
  if (execution.status === "FAILED" && execution.budget?.kind === "EXCEEDED") {
    return { route: "BUDGET_AUTHORITY" };
  }

  const canonical = execution.canonical;
  // No frozen result behind this outcome: the facade produced it on its own — a failure before the
  // provider was contacted, the `maxSteps` gate, an admission block. Nothing to plan from.
  if (canonical === undefined) return { route: "COMPATIBILITY" };

  if (canonical.kind === "FINAL_CANDIDATE") {
    // Completion authority is Phase 3E. Until then the legacy verification bridge owns it, and the
    // planner's own FINAL_CANDIDATE branch stays fail-closed rather than being used as a fallback.
    return { route: "VERIFICATION_COMPATIBILITY" };
  }

  if (canonical.kind === "FAILED" && execution.status === "FAILED") {
    // A retry needs an attempt number and a next attempt time the planner does not have. The Run
    // Retry Policy owns that decision; the planner must not invent a schedule.
    return execution.retry?.retryable === true
      ? { route: "RETRY_COMPATIBILITY" }
      : canonicalRoute(directive, canonical);
  }

  return canonicalRoute(directive, canonical);
}

function canonicalRoute(
  directive: AdvanceAgentDirective | undefined,
  result: AgentLoopAdvanceResult,
): AgentEffectSettlementRoute {
  return directive === undefined
    ? { route: "COMPATIBILITY" }
    : { route: "CANONICAL_AGENT_EFFECT", directive, result };
}

/**
 * Assert the compatibility execution epoch agrees with the coordinator's decision.
 *
 * `epoch` survives as a Core execution detail: it selects which legacy loop entry point runs. It is
 * *not* the planner's authority — the directive is — and this check is what keeps the two from
 * silently disagreeing. A disagreement is a routing bug, so it fails loudly rather than settling
 * the effect under whichever of the two happened to be consulted first.
 */
export function assertExecutionEpochMatchesDirective(
  epoch: "START" | "TOOL_RESULTS" | "VERIFICATION_REPAIR",
  directive: AdvanceAgentDirective,
): void {
  const expected: Record<typeof epoch, readonly AdvanceAgentDirective["reason"][]> = {
    START: ["INITIAL", "RETRY"],
    TOOL_RESULTS: ["TOOL_RESULTS", "RETRY"],
    VERIFICATION_REPAIR: ["COMPLETION_REPAIR"],
  };
  if (expected[epoch].includes(directive.reason)) return;
  throw new Error(
    `Run execution epoch ${epoch} disagrees with the coordinator's ${directive.reason} decision.`,
  );
}
