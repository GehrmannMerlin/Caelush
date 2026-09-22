import type { ObservationId } from "@caelush/protocol";

/**
 * Tool Result provenance.
 *
 * Phase 5B's Interface Freeze Errata replaced a mandatory `observationId` with this union, because
 * the mandatory form asserted something durable history does not support.
 *
 * ```text
 * OBSERVATION      a real ToolObservation execution truth exists and is identified
 * NO_OBSERVATION   this model-visible Tool feedback has no ToolObservation by design
 * ```
 *
 * ## `NO_OBSERVATION` is a domain fact, not a failure
 *
 * ```text
 * NO_OBSERVATION  !=  UNKNOWN_OBSERVATION_ID
 * NO_OBSERVATION  !=  NOT_LOADED
 * NO_OBSERVATION  !=  MIGRATION_FAILURE
 * NO_OBSERVATION  !=  "we forgot to populate it"
 * ```
 *
 * The Tool System legitimately produces model-visible feedback for calls that never executed. A
 * `REJECTED` call was refused before a handler ran; a `SKIPPED` call is a trailing item after an
 * uncertain execution; a resource replan produces synthetic results and writes no invocation at all.
 * Each still reaches the model as a Tool Result, and none of them has an execution to point at.
 *
 * So this arm is where those results live. It is terminal: nothing repairs it, nothing re-derives it,
 * and nothing replaces it with a fabricated identity.
 *
 * ## Why a union rather than an optional field
 *
 * ```ts
 * observationId?: ObservationId     // not this
 * ```
 *
 * An absent optional field cannot distinguish "legitimately no observation" from "not populated yet",
 * "not loaded", "the migration could not determine it" or "a bug". The union forces the producer to
 * state which one it means, and `NO_OBSERVATION` is a claim that can be checked against the Tool
 * System rather than an omission that has to be interpreted.
 *
 * ## What it is not
 *
 * `ObservationId` continues to mean exactly one thing: an `agent_observations` row exists. There is no
 * sentinel value (`"none"`, `"legacy"`, `"synthetic"`) and no synthetic `ToolObservation` variant, so
 * an `OBSERVATION` arm can always be resolved against real execution truth.
 */
export type ToolResultObservationRef =
  | {
      readonly kind: "OBSERVATION";

      readonly observationId: ObservationId;
    }
  | {
      readonly kind: "NO_OBSERVATION";
    };

/** Every observation-ref kind, in canonical order. */
export const TOOL_RESULT_OBSERVATION_REF_KINDS = [
  "OBSERVATION",
  "NO_OBSERVATION",
] as const satisfies readonly ToolResultObservationRef["kind"][];

/** Build the observation-backed arm. */
export function toolResultObservation(observationId: ObservationId): ToolResultObservationRef {
  return Object.freeze({ kind: "OBSERVATION", observationId });
}

/**
 * Build the no-observation arm.
 *
 * A shared frozen value, because the value carries no data: there is exactly one way to say "this
 * feedback has no execution behind it".
 */
export const NO_TOOL_RESULT_OBSERVATION: ToolResultObservationRef = Object.freeze({
  kind: "NO_OBSERVATION",
});

/** True when this result has a real execution observation behind it. */
export function hasToolResultObservation(
  ref: ToolResultObservationRef,
): ref is Extract<ToolResultObservationRef, { kind: "OBSERVATION" }> {
  return ref.kind === "OBSERVATION";
}

/** Assert a well-formed observation reference. */
export function assertToolResultObservationRef(
  value: unknown,
): asserts value is ToolResultObservationRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool result observation reference must be an object.");
  }
  const candidate = value as { readonly kind?: unknown; readonly observationId?: unknown };
  switch (candidate.kind) {
    case "OBSERVATION":
      if (typeof candidate.observationId !== "string" || candidate.observationId.length === 0) {
        throw new TypeError(
          "A tool result observation reference must name the observation it refers to.",
        );
      }
      return;
    case "NO_OBSERVATION":
      // The arm carries no field by design: there is nothing to validate and nothing to omit.
      return;
    default:
      throw new TypeError("Tool result observation reference kind is unknown.");
  }
}
