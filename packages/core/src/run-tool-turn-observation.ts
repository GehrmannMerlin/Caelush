import type { ToolTurnResult } from "@caelush/agent";
import type { ToolBatchItemOutcome } from "@caelush/agent";

/**
 * The Core-private record of what one Tool turn actually did.
 *
 * ```text
 * Core-private — never a @caelush/agent public contract
 * ```
 *
 * The frozen `ToolTurnResult` is the model-facing answer: it says what the model will be told, and
 * it is deliberately free of every host fact that produced that answer. Three of those host facts
 * cannot be recovered from it, and each of them is needed by a durable write:
 *
 * ```text
 * WHICH batch actually ran      a durable RUNNING invocation must be recovered, never re-dispatched
 * the resource decision         RESOURCE_WAIT carries a reason, not the replan count `WAITING_RESOURCE`
 *                               has always persisted
 * the raw observations          the Tool Layer keeps the unbounded output; only its projection is
 *                               model-facing, and a later forced Context recovery re-reads the raw
 * ```
 *
 * Exactly as in Phase 3C's `AgentTurnObservation`, this is the channel for those facts: it is
 * produced by the Tool turn adapter, consumed by the Run Layer's own settlement, and it is
 * **not** added to the frozen Tool contract or to the frozen effect context.
 *
 * Every field is a fact about work that *did* happen. Nothing here is a guess: a mode is the mode
 * the caller entered with, a resource decision is the decision the governor returned, and an
 * outcome is the discriminant the Tool Layer actually produced.
 */

/** The Core-private decision the resource governor made about one batch. */
export type RunToolResourceDecision =
  | "ALLOW"
  | "ALLOW_WITH_NUDGE"
  | "RENEW_AND_ALLOW"
  | "REPLAN"
  | "WAIT_FOR_RESOURCE_DECISION"
  | "HARD_STOP";

/**
 * The batch outcome the Tool Layer produced, when it produced one.
 *
 * `undefined` means no batch was attempted at all — a resource REPLAN, a resource wait or a
 * resource hard stop never reached the Tool Layer, and reporting an outcome for one would claim
 * execution that never happened.
 */
export type RunToolUnderlyingOutcome = ToolTurnResult["kind"];

/** One raw Tool observation, as the Tool Layer reported it. */
export interface RunToolRawObservation {
  readonly externalCallId: string;
  readonly invocationId?: string | undefined;
  readonly rawArtifactRef?: string | undefined;
}

/**
 * The Core-private observation of one executed Tool turn.
 *
 * Mutable on purpose: the adapter creates it when the turn is resolved, before any work happens,
 * and fills in the facts as they become known. That ordering is what keeps `executionAttempted`
 * honest — a turn that never reaches the Tool Layer reports `false` rather than an outcome it
 * never produced.
 */
export interface RunToolTurnObservation {
  /**
   * How this batch was actually entered.
   *
   * ```text
   * EXECUTE  a fresh batch, dispatched for the first time
   * RECOVER  a batch that may already be durable, settled through the restart-aware path
   * ```
   *
   * This is the exactly-once protection of Phase 7C, carried forward. A durable `RUNNING`
   * invocation must be recovered and never re-dispatched, and only the layer that knows *why* it is
   * driving can say which of the two this is. It is deliberately not derived from the frozen
   * directive: the directive says which batch is next, not whether its work already happened.
   */
  readonly effectiveMode: "EXECUTE" | "RECOVER";
  /** The resource governor's decision, when a policy was configured. */
  resourceDecision?: RunToolResourceDecision | undefined;
  /**
   * The durable replan count at settlement time.
   *
   * Read from the resource ledger after the decision, and it is the *only* authority for the count
   * a `WAITING_RESOURCE` checkpoint persists — the frozen `RESOURCE_WAIT` result carries a reason
   * and nothing else, and re-deriving the number later would be a second accounting authority.
   */
  resourceReplanCount?: number | undefined;
  /** Whether this turn reached the Tool Layer at all. */
  executionAttempted: boolean;
  /** The discriminant the Tool Layer produced, when it produced one. */
  underlyingOutcome?: RunToolUnderlyingOutcome | undefined;
  /** The raw observations the Tool Layer reported, in assistant source order. */
  rawObservations?: readonly RunToolRawObservation[] | undefined;
}

/** The observation of a Tool turn that has not reached the Tool Layer yet. */
export function createRunToolTurnObservation(
  input: Pick<RunToolTurnObservation, "effectiveMode">,
): RunToolTurnObservation {
  return { executionAttempted: false, ...input };
}

/**
 * Record the raw observations of a completed Tool Layer outcome.
 *
 * Only an `OBSERVATION` item names a durable invocation and therefore a raw artifact pointer: a
 * `REJECTED` call never ran and a `SKIPPED` call was never started, so neither has raw output and
 * inventing one would point a Context recovery at an artifact nobody wrote.
 *
 * The pointer is read from the **durable** `ToolObservation` the canonical batch carried, which is the
 * same authority the settlement wrote — not from a model-facing message, which deliberately has no field
 * for it.
 */
export function rawObservationsOf(
  items: readonly ToolBatchItemOutcome[],
): readonly RunToolRawObservation[] {
  return items.map((item) => {
    if (item.kind !== "OBSERVATION") return { externalCallId: item.call.externalCallId };
    const rawArtifactRef = item.observation.rawArtifactRef;
    return {
      externalCallId: item.call.externalCallId,
      invocationId: item.invocationId,
      ...(rawArtifactRef === undefined ? {} : { rawArtifactRef }),
    };
  });
}
