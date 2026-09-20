import {
  ToolObservationSchema,
  type JsonObject,
  type ObservationId,
  type RunId,
  type StepId,
  type TimestampMs,
  type ToolInvocation,
  type ToolInvocationId,
  type ToolObservation,
} from "@caelush/protocol";

import { cloneJsonValue, deepFreezeJson } from "../schema/json-canonical.js";
import { ToolExecutionInvariantError } from "./durable-errors.js";

/**
 * The durable Tool observation lifecycle.
 *
 * ```text
 * ToolInvocation     what was attempted, and how it ended
 * ToolObservation    what the model and the host may see about it
 * ```
 *
 * Phase 4C moved the canonical factory and invariant here from `packages/tools/src/observation.ts`.
 * The legacy module is now a re-export facade, so there is one observation factory in the repository.
 *
 * ## An observation is derived, never authored
 *
 * Every field of an observation is a function of the invocation it belongs to:
 *
 * ```text
 * runId               == invocation.runId
 * stepId              == invocation.stepId
 * toolInvocationId    == invocation.id
 * createdAt           == invocation.finishedAt      (the settlement timestamp)
 * isError             false for COMPLETED, true for FAILED
 * ```
 *
 * The point of restating the invariant as an assertion is that a durable observation which disagrees
 * with its invocation is not a cosmetic problem: it is a second, conflicting account of the same
 * execution. Recovery reads both, so they must be unable to disagree.
 */
export interface CreateToolObservationInput {
  readonly id: ObservationId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly toolInvocationId: ToolInvocationId;
  /**
   * The archived, complete pre-projection Tool output.
   *
   * It points at the raw artifact the host wrote *before* sanitization bounded the result, so a
   * recovery or a re-projection can reach the original. It is deliberately not part of any settlement
   * signature the general layer froze: the layer that owns the archive supplies it.
   */
  readonly rawArtifactRef?: string | undefined;
  readonly content: string;
  readonly details?: JsonObject | undefined;
  readonly isError: boolean;
  readonly createdAt: TimestampMs;
}

/**
 * Build one durable observation.
 *
 * `details` are cloned and deep-frozen for the same reason invocation arguments are: the value becomes
 * durable evidence, and a caller that kept a live reference could otherwise change what "was observed"
 * after the fact.
 */
export function createToolObservation(input: CreateToolObservationInput): ToolObservation {
  const candidate: ToolObservation = {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    kind: "TOOL",
    toolInvocationId: input.toolInvocationId,
    ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
    content: input.content,
    ...(input.details === undefined
      ? {}
      : { details: deepFreezeJson(cloneJsonValue(input.details)) as JsonObject }),
    isError: input.isError,
    createdAt: input.createdAt,
  };
  return Object.freeze(ToolObservationSchema.parse(candidate));
}

/**
 * Refuse an observation that does not belong to its invocation, or that contradicts its outcome.
 *
 * ```text
 * COMPLETED → isError false
 * FAILED    → isError true
 * CANCELLED → either; a cancelled call may have produced a partial result or none at all
 * non-terminal → no final observation at all
 * ```
 *
 * The last rule is the one that keeps a "provisional" observation from appearing mid-execution: a
 * `RUNNING` invocation has no final observation, so a reader can always tell "this finished" from
 * "this is still going" by asking whether an observation exists.
 */
export function assertToolObservationInvariant(
  observation: ToolObservation,
  invocation: ToolInvocation,
): void {
  const parsed = ToolObservationSchema.parse(observation);
  if (
    parsed.runId !== invocation.runId ||
    parsed.stepId !== invocation.stepId ||
    parsed.toolInvocationId !== invocation.id
  ) {
    throw new ToolExecutionInvariantError("Tool observation does not belong to its invocation.");
  }
  if (invocation.status === "COMPLETED" && parsed.isError) {
    throw new ToolExecutionInvariantError(
      "A completed tool invocation requires a non-error observation.",
    );
  }
  if (invocation.status === "FAILED" && !parsed.isError) {
    throw new ToolExecutionInvariantError(
      "A failed tool invocation requires an error observation.",
    );
  }
  if (parsed.createdAt !== invocation.finishedAt) {
    throw new ToolExecutionInvariantError("Tool observation must use the settlement timestamp.");
  }
  if (
    invocation.status === "REQUESTED" ||
    invocation.status === "WAITING_APPROVAL" ||
    invocation.status === "RUNNING"
  ) {
    throw new ToolExecutionInvariantError(
      "A non-terminal tool invocation cannot have a final observation.",
    );
  }
}
