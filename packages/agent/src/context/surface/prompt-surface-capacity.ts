import { UTF8_BYTES_PER_TOKEN } from "../token/context-token-estimator.js";
import { PROMPT_SURFACE_LIMITS, type PromptSurfaceRecordKind } from "./prompt-surface.js";
import {
  diffPromptSurfaceSections,
  renderPromptSurfaceRecord,
  type PromptSurfaceSectionState,
} from "./prompt-surface-v3.js";

/**
 * The dimension of the Prompt Surface that a capacity decision observed.
 *
 * Each dimension is a *local projection* bound: the epoch is a bounded replayable log, and
 * one of those bounds being reached is a normal consequence of a long Run. It is never an
 * error condition by itself and it is never evidence about the model or the provider.
 */
export const PROMPT_SURFACE_CAPACITY_DIMENSIONS = [
  "VISIBLE_RECORDS",
  "DECISION_RECORDS",
  "EPOCH_UTF8_BYTES",
  "BASELINE_UTF8_BYTES",
  "SECTION_STATES",
] as const;

export type PromptSurfaceCapacityDimension = (typeof PROMPT_SURFACE_CAPACITY_DIMENSIONS)[number];

/**
 * What the next durable decision must do for this Step.
 *
 * `APPEND` and `ROLLOVER_REQUIRED` are both healthy outcomes: the second one means the current
 * epoch is full and this Step's complete Section state must become the next epoch's baseline.
 * `BASELINE_TOO_LARGE` is the only terminal outcome, and it is terminal because a baseline that
 * does not fit cannot be made to fit by rotating again.
 */
export type PromptSurfaceCapacityDecision =
  | { readonly kind: "APPEND" }
  | {
      readonly kind: "ROLLOVER_REQUIRED";
      readonly dimension: PromptSurfaceCapacityDimension;
      readonly observed: number;
      readonly limit: number;
    }
  /**
   * The epoch still has room, but replaying it costs more than the soft budget and a baseline of the
   * same Section view is cheaper.
   *
   * This is an *early* rollover, not a capacity boundary: nothing was full. It exists because a
   * Prompt Surface Epoch is re-sent on every request, so an epoch that is comfortable for storage can
   * still be expensive to replay for a hundred Steps.
   */
  | {
      readonly kind: "ROLLOVER_SOFT";
      /** Replay cost of the epoch plus this candidate, in UTF-8 bytes. */
      readonly observed: number;
      /** The soft budget it exceeded, in UTF-8 bytes. */
      readonly limit: number;
    }
  | {
      readonly kind: "BASELINE_TOO_LARGE";
      readonly dimension: PromptSurfaceCapacityDimension;
      readonly observed: number;
      readonly limit: number;
    };

export interface PromptSurfaceCapacityInput {
  /**
   * The current, already integrity-checked epoch. Only the decision kinds and their recorded
   * byte lengths matter here; the decision never re-reads Section content.
   */
  readonly epoch: {
    readonly records?: readonly {
      readonly kind: PromptSurfaceRecordKind;
      readonly byteLength: number;
    }[];
    readonly sectionStates?: readonly PromptSurfaceSectionState[];
  };
  /** The decision this Step would append to the current epoch. */
  readonly candidate: {
    readonly kind: PromptSurfaceRecordKind;
    readonly byteLength: number;
  };
  /** The complete Section view this Step must leave in effect. */
  readonly targetSectionStates: readonly PromptSurfaceSectionState[];
  /**
   * The replay cost this epoch may reach before an early rollover becomes worthwhile, in UTF-8 bytes.
   *
   * Omitted means "no soft budget": the decision then only reacts to the hard epoch bounds, which is
   * the behaviour every historical caller had.
   */
  readonly replaySoftBudgetBytes?: number;
}

/**
 * Decide whether the next durable decision appends to the current epoch or starts the next one.
 *
 * The arithmetic is deliberately inclusive: a candidate that lands exactly on a limit is legal,
 * and the *next* decision is the one that rolls over. That keeps the historical boundary that
 * produced the 128-record failure meaningful — it stays a real limit, it just stops being fatal.
 *
 * Nothing here reads time, randomness, storage or the model. The same input always produces the
 * same decision, which is what lets the caller record it and the tests pin it.
 */
export function decidePromptSurfaceCapacity(
  input: PromptSurfaceCapacityInput,
): PromptSurfaceCapacityDecision {
  const records = input.epoch.records ?? [];
  const visibleRecords = records.reduce(
    (total, record) => (record.kind === "NOOP" ? total : total + 1),
    0,
  );
  const nextVisibleRecords = visibleRecords + (input.candidate.kind === "NOOP" ? 0 : 1);
  const nextDecisionRecords = records.length + 1;
  const nextEpochBytes =
    records.reduce((total, record) => total + record.byteLength, 0) + input.candidate.byteLength;

  const overflow = firstOverflow([
    {
      dimension: "VISIBLE_RECORDS",
      observed: nextVisibleRecords,
      limit: PROMPT_SURFACE_LIMITS.maxEpochSnapshots,
    },
    {
      dimension: "DECISION_RECORDS",
      observed: nextDecisionRecords,
      limit: PROMPT_SURFACE_LIMITS.maxEpochRecords,
    },
    {
      dimension: "EPOCH_UTF8_BYTES",
      observed: nextEpochBytes,
      limit: PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes,
    },
  ]);
  if (overflow === undefined) {
    return earlyRollover(input, records, nextEpochBytes);
  }

  // A rollover is only allowed when the complete target view still fits in one epoch. Rotating
  // into a baseline that cannot be persisted would replace a recoverable boundary with a
  // corrupt one, so the fit check runs before the decision is reported.
  const baseline = assessPromptSurfaceBaseline(input.targetSectionStates);
  if (baseline !== undefined) {
    return Object.freeze({
      kind: "BASELINE_TOO_LARGE" as const,
      dimension: baseline.dimension,
      observed: baseline.observed,
      limit: baseline.limit,
    });
  }
  return Object.freeze({
    kind: "ROLLOVER_REQUIRED" as const,
    dimension: overflow.dimension,
    observed: overflow.observed,
    limit: overflow.limit,
  });
}

/**
 * The token budget above which a replay is worth rotating early.
 *
 * A constant, not a ratio: the reason to rotate is that a request is becoming expensive, and
 * "expensive" is a property of the request rather than of the window it sits in. Both the bounded
 * working-set policy and the legacy policy cap out here.
 */
const MAX_REPLAY_SOFT_BUDGET_TOKENS = 24_000;

/**
 * Convert the policy's replay budget into the byte budget the capacity decision compares against.
 *
 * ```text
 * working set   min(24000, floor(target × 0.25))   a quarter of what the Run aims to carry
 * legacy        min(24000, floor(effective × 0.10)) a tenth of the input budget
 * ```
 *
 * The unit conversion is the estimator's own constant, not a second guess at it: the heuristic
 * estimator used by the daemon converts three UTF-8 bytes to one token, and a hard byte bound has to
 * be compared in the same unit the records are stored in.
 */
export function promptSurfaceReplaySoftBudgetBytes(input: {
  readonly workingSetTargetTokens?: number;
  readonly effectiveInputLimitTokens: number;
}): number {
  const budgetTokens =
    input.workingSetTargetTokens === undefined
      ? Math.min(MAX_REPLAY_SOFT_BUDGET_TOKENS, Math.floor(input.effectiveInputLimitTokens * 0.1))
      : Math.min(MAX_REPLAY_SOFT_BUDGET_TOKENS, Math.floor(input.workingSetTargetTokens * 0.25));
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new RangeError("Prompt Surface replay budget is not a positive token count.");
  }
  return budgetTokens * UTF8_BYTES_PER_TOKEN;
}

interface CapacityBound {
  readonly dimension: PromptSurfaceCapacityDimension;
  readonly observed: number;
  readonly limit: number;
}

/**
 * Rotate early only when rotating actually makes the request cheaper.
 *
 * ```text
 * replay over the soft budget   the cost this decision is about
 * baseline smaller than replay  rotating must gain, or it is churn
 * baseline inside the budget    a baseline that is itself over budget cannot be the answer;
 *                               the full pressure/compaction decision owns that case
 * ```
 *
 * Rotating is not free: it starts a new epoch, which costs one baseline and abandons the cacheable
 * prefix of the old one. Each condition removes one way of paying that cost for nothing.
 */
function earlyRollover(
  input: PromptSurfaceCapacityInput,
  records: readonly { readonly byteLength: number }[],
  replayBytes: number,
): PromptSurfaceCapacityDecision {
  const softBudget = input.replaySoftBudgetBytes;
  if (softBudget === undefined) return Object.freeze({ kind: "APPEND" });
  if (!Number.isSafeInteger(softBudget) || softBudget < 1) {
    throw new RangeError("Prompt Surface replay soft budget must be a positive integer.");
  }
  if (replayBytes <= softBudget) return Object.freeze({ kind: "APPEND" });
  // A one-record epoch has nothing to fold: rotating it would replace one record with one baseline
  // and buy at most that record's bytes. Two records is the first shape where the replay is
  // genuinely accumulating.
  if (records.length < 2) return Object.freeze({ kind: "APPEND" });
  const baselineBytes = promptSurfaceBaselineByteLength(input.targetSectionStates);
  if (baselineBytes >= replayBytes) return Object.freeze({ kind: "APPEND" });
  if (baselineBytes > softBudget) {
    // Rotating would replace a large replay with a large baseline. The budget decision belongs to
    // the pressure/compaction path, which can summarize history; a rollover cannot.
    return Object.freeze({ kind: "APPEND" });
  }
  return Object.freeze({
    kind: "ROLLOVER_SOFT" as const,
    observed: replayBytes,
    limit: softBudget,
  });
}

/** The full Section view as one baseline record, measured against the single-record bound. */
export function assessPromptSurfaceBaseline(
  sectionStates: readonly PromptSurfaceSectionState[],
): CapacityBound | undefined {
  if (sectionStates.length > PROMPT_SURFACE_LIMITS.maxEpochSectionStates) {
    return {
      dimension: "SECTION_STATES",
      observed: sectionStates.length,
      limit: PROMPT_SURFACE_LIMITS.maxEpochSectionStates,
    };
  }
  const byteLength = promptSurfaceBaselineByteLength(sectionStates);
  if (byteLength > PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes) {
    return {
      dimension: "BASELINE_UTF8_BYTES",
      observed: byteLength,
      limit: PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes,
    };
  }
  return undefined;
}

/**
 * The exact UTF-8 size of the baseline that would carry this Section view.
 *
 * Rendered through the same function that produces durable record bytes, so the measurement
 * cannot drift from what `createPromptSurfaceRecord` would persist.
 */
export function promptSurfaceBaselineByteLength(
  sectionStates: readonly PromptSurfaceSectionState[],
): number {
  const diff = diffPromptSurfaceSections([], sectionStates, true);
  return Buffer.byteLength(renderPromptSurfaceRecord("BASELINE", diff.updates), "utf8");
}

function firstOverflow(bounds: readonly CapacityBound[]): CapacityBound | undefined {
  for (const bound of bounds) {
    if (!Number.isSafeInteger(bound.observed) || bound.observed < 0) {
      throw new RangeError("Prompt Surface capacity observation is not a non-negative integer.");
    }
    if (bound.observed > bound.limit) return bound;
  }
  return undefined;
}

/**
 * Closed reasons for a Prompt Surface that cannot continue.
 *
 * Only `BASELINE_TOO_LARGE` is a capacity outcome. The rest are local infrastructure outcomes,
 * and they are kept apart from capacity on purpose: a projection that failed to persist is not a
 * full epoch, and reporting it as one would send the caller into the wrong recovery path.
 */
export const PROMPT_SURFACE_CAPACITY_REASONS = [
  "BASELINE_TOO_LARGE",
  "EPOCH_ROLLOVER_CONFLICT",
  "EPOCH_ROLLOVER_FAILED",
  "SURFACE_PERSISTENCE_FAILED",
] as const;

export type PromptSurfaceCapacityReason = (typeof PROMPT_SURFACE_CAPACITY_REASONS)[number];

export type PromptSurfaceCapacityStage = "surface_capacity" | "surface_persistence";

/**
 * A local Prompt Surface failure carrying a safe, stable classification.
 *
 * `code` is the structural vocabulary the Agent Loop already understands:
 *
 * ```text
 * CONTEXT_EXHAUSTED   the required view does not fit; existing budget recovery may still help
 * CONTEXT_UNAVAILABLE a local projection/storage failure; recovery must not be invented
 * ```
 *
 * The message never quotes a Section, an argument, a path or the underlying exception: those
 * remain in `cause`, which the loop deliberately does not carry across its boundary.
 */
export class PromptSurfaceCapacityError extends Error {
  readonly code: "CONTEXT_EXHAUSTED" | "CONTEXT_UNAVAILABLE";
  readonly reason: PromptSurfaceCapacityReason;
  readonly stage: PromptSurfaceCapacityStage;
  readonly dimension?: PromptSurfaceCapacityDimension;
  readonly observed?: number;
  readonly limit?: number;

  constructor(
    input: {
      readonly reason: PromptSurfaceCapacityReason;
      readonly stage: PromptSurfaceCapacityStage;
      readonly dimension?: PromptSurfaceCapacityDimension;
      readonly observed?: number;
      readonly limit?: number;
      readonly cause?: unknown;
    },
    message: string,
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "PromptSurfaceCapacityError";
    this.code = input.reason === "BASELINE_TOO_LARGE" ? "CONTEXT_EXHAUSTED" : "CONTEXT_UNAVAILABLE";
    this.reason = input.reason;
    this.stage = input.stage;
    if (input.dimension !== undefined) this.dimension = input.dimension;
    if (input.observed !== undefined) this.observed = input.observed;
    if (input.limit !== undefined) this.limit = input.limit;
  }
}

/** Build the terminal capacity failure for a baseline that cannot fit in any single epoch. */
export function promptSurfaceBaselineTooLarge(
  dimension: PromptSurfaceCapacityDimension,
  observed: number,
  limit: number,
): PromptSurfaceCapacityError {
  return new PromptSurfaceCapacityError(
    { reason: "BASELINE_TOO_LARGE", stage: "surface_capacity", dimension, observed, limit },
    "The complete model context projection does not fit in one Prompt Surface epoch.",
  );
}
