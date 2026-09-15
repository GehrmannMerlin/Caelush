import type { ToolTurnResult } from "@caelush/agent";

import type { AgentBudgetBlock } from "./agent-errors.js";
import type { RunToolTurnObservation } from "./run-tool-turn-observation.js";
/**
 * The production Tool effect settlement router.
 *
 * ```text
 * one executed Tool turn -> exactly one settlement authority
 * ```
 *
 * Phase 3C made the Run transition planner the settlement authority for every transition the frozen
 * contract can express, and the frozen planner already plans four of the five Tool turn
 * outcomes — `COMPLETED`, `REPLAN`, `WAITING_APPROVAL` and `BUDGET_EXCEEDED` — as ordinary
 * transitions. This router decides *which* authority settles a Tool effect, and it is deliberately
 * the only place that decides it:
 *
 * ```text
 * CANONICAL_TOOL_EFFECT      the frozen planner plans the commit
 * RESOURCE_COMPATIBILITY     WAITING_RESOURCE needs the durable replan count the frozen result
 *                            does not carry; the Core-private observation is its only authority
 * BUDGET_AUTHORITY           a durable budget refusal owns its own cleanup and accounting
 * ```
 *
 * **Classification is by typed discriminant only.** No branch of this file reads an error message,
 * a status string or a Tool name: a router that guessed from text would be a second authority over
 * the lifecycle, and it would keep guessing after the text changed.
 *
 * **There is no generic fallback.** A canonical branch is planned by the planner or it fails loudly;
 * a planner error is never caught and turned into a compatibility settlement, because that would
 * leave two authorities able to settle one effect with nothing recording which of them did.
 */

/** What settles one executed Tool turn. */
export type ToolEffectSettlementRoute =
  | {
      readonly route: "CANONICAL_TOOL_EFFECT";
      /** The exact frozen result the Tool turn coordinator returned. */
      readonly result: Exclude<ToolTurnResult, { kind: "RESOURCE_WAIT" | "BUDGET_EXCEEDED" }>;
    }
  | {
      readonly route: "RESOURCE_COMPATIBILITY";
      /** The exact durable replan count the resource ledger held at the admission decision. */
      readonly replanCount: number;
    }
  | {
      readonly route: "BUDGET_AUTHORITY";
      /**
       * The exact durable block the Tool budget authority returned.
       *
       * Never re-derived from a frozen error projection: the numbers are the accounting, and a
       * router that recomputed them would be a second budget authority.
       */
      readonly block: Extract<AgentBudgetBlock, { kind: "EXCEEDED" }>;
    };

export interface ToolEffectSettlementInput {
  /** The exact frozen result `ToolTurnCoordinator.execute()` returned. */
  readonly result: ToolTurnResult;
  /** The Core-private record of what the Tool turn actually did. */
  readonly observation: RunToolTurnObservation;
}

/** Classify one executed Tool effect onto exactly one settlement authority. */
export function classifyToolEffectSettlement(
  input: ToolEffectSettlementInput,
): ToolEffectSettlementRoute {
  const { result, observation } = input;

  switch (result.kind) {
    case "COMPLETED":
    case "REPLAN":
    case "WAITING_APPROVAL":
      return { route: "CANONICAL_TOOL_EFFECT", result };
    case "RESOURCE_WAIT":
      // The frozen planner refuses this branch on purpose: `WAITING_RESOURCE` has always persisted
      // a `replanCount`, and the frozen `RESOURCE_WAIT` result carries a reason and nothing else. A
      // pure planner that invented the number would be a second accounting authority, so the count
      // travels out of band in the observation and the compatibility settlement uses exactly it.
      return {
        route: "RESOURCE_COMPATIBILITY",
        replanCount: requireReplanCount(observation),
      };
    case "BUDGET_EXCEEDED":
      // A budget refusal finalizes the Run: it disarms the timers, cleans up the Run's owned
      // resources and cancels pending approvals before it settles. Those are not a transition a
      // pure planner can describe, so the effect is routed to the existing budget authority rather
      // than planned. The block is narrowed here, and re-derived nowhere.
      return { route: "BUDGET_AUTHORITY", block: requireExceededBlock(result.block) };
    default:
      return assertNeverToolTurnResult(result);
  }
}

/**
 * The durable budget block a `BUDGET_EXCEEDED` result carries, narrowed to the exceeded arm.
 *
 * The frozen block union also has an `UNAVAILABLE` arm — the admission authority could not estimate
 * — and a *Tool* batch that reported it would be reporting something this boundary cannot settle as
 * an exceeded budget. Refusing is the honest answer: an unestimatable Tool batch is an enforcement
 * failure, not exhaustion, and it must not be recorded as if the Run had spent its budget.
 */
function requireExceededBlock(
  block: Extract<ToolTurnResult, { kind: "BUDGET_EXCEEDED" }>["block"],
): Extract<AgentBudgetBlock, { kind: "EXCEEDED" }> {
  if (block.kind !== "EXCEEDED") {
    // `UNAVAILABLE` means enforcement could not estimate, which is an enforcement failure rather
    // than exhaustion. Recording it as an exceeded budget would claim the Run spent a budget it
    // never measured, so the settlement refuses instead.
    throw new TypeError(
      "A Tool batch cannot report an unavailable budget block: budget enforcement was unavailable.",
    );
  }
  return block;
}

/**
 * The replan count a `RESOURCE_WAIT` settlement persists.
 *
 * A missing count is a routing failure, not a default: persisting zero would record a Run that had
 * never replanned, and the durable checkpoint is the only place the number is ever read from.
 */
function requireReplanCount(observation: RunToolTurnObservation): number {
  const replanCount = observation.resourceReplanCount;
  if (replanCount === undefined || !Number.isSafeInteger(replanCount) || replanCount < 0) {
    throw new TypeError(
      "A RESOURCE_WAIT settlement requires the durable replan count the admission decision read.",
    );
  }
  return replanCount;
}

/** Exhaustiveness guard: a new discriminant must break the build rather than lose a settlement. */
function assertNeverToolTurnResult(result: never): never {
  throw new TypeError(
    `Unhandled Tool turn result: ${JSON.stringify((result as { kind?: unknown }).kind)}`,
  );
}
