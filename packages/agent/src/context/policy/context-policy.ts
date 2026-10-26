import type { AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import {
  assertContextRequestOverhead,
  createContextRequestOverheadEstimator,
  type ContextRequestOverhead,
} from "../token/request-overhead-estimator.js";
import type { ContextItem, ContextItemId } from "../item/context-item.js";
import type { DeepCompactionPolicy } from "./request-headroom.js";

export interface ContextPolicyOptions {
  readonly outputReserveTokens?: number;
  readonly safetyReserveTokens?: number;
  readonly proactiveCompactionRatio?: number;
  readonly emergencyCompactionRatio?: number;
  readonly targetRecentTailTokensCap?: number;
  readonly targetRecentTailRatio?: number;
  readonly minRecentTailTokensCap?: number;
  readonly minRecentTailRatio?: number;
  readonly maxSingleObservationTokensCap?: number;
  readonly maxSingleObservationRatio?: number;
  readonly maxObservationBatchTokensCap?: number;
  readonly maxObservationBatchRatio?: number;
  readonly conversationCapTokens?: number;
  readonly sourceLimits?: Readonly<Record<string, number>>;
  /** Whether crossing the configured trigger starts a compaction attempt. */
  readonly proactiveCompactionEnabled?: boolean;
  /** Run-frozen V2 working-set thresholds; absent retains the historical Context policy. */
  readonly workingSet?: ContextWorkingSetPolicy;
  /** Explicit source retention and trigger policy used only by TURN_BUDGET_V4 Runs. */
  readonly deepCompaction?: DeepCompactionPolicy;
  /**
   * Run-frozen headroom thresholds.
   *
   * ```text
   * proactive  W - O - S - G   reorganize as soon as the next turn's growth no longer fits
   * emergency  W - O - S       the input itself no longer fits
   * ```
   *
   * This replaces a fixed working-set target with the only quantity the user actually cares about:
   * how much room is left after this request. It is not a renamed quota — `G` is derived from the
   * bounded Tool-result growth of a single next turn, so the trigger scales with the model's window
   * instead of capping history at a constant.
   */
  readonly requestHeadroom?: ContextRequestHeadroomPolicy;
}

export interface ContextRequestHeadroomPolicy {
  readonly expectedGrowthTokens: number;
  readonly postCompactionRatio?: number;
  /** Optional proactive reorganization threshold as a fraction of the usable input budget. */
  readonly proactiveRatio?: number;
}

export interface ContextWorkingSetPolicy {
  readonly targetTokens: number;
  readonly triggerRatio: number;
  readonly postCompactionRatio: number;
  readonly allowCurrentTurnPrefix: boolean;
  readonly cooldownTurns: number;
}

export interface ContextPolicyInput {
  readonly model: ModelDescriptor;
  readonly tools?: readonly AIToolSpec[];
  readonly requestOverhead?: ContextRequestOverhead;
  readonly options?: ContextPolicyOptions;
}

export type ContextPressureState = "NORMAL" | "PROACTIVE" | "EMERGENCY";

export interface AdaptiveContextBudgetInput {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly configuredOutputCeiling?: number;
  readonly requestOverheadTokens: number;
}

export interface AdaptiveContextBudget {
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly preferredOutputCeiling: number;
  readonly effectiveInputLimitTokens: number;
}

export interface ContextBudgetSnapshot {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly requestOverheadTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly mandatoryTokens: number;
  readonly selectedTokens: number;
  readonly remainingTokens: number;
}

export type ContextItemDisposition = "SELECTED" | "DROPPED" | "DEFERRED" | "COMPACTED";
export type ContextItemDecisionReason =
  | "MANDATORY"
  | "PINNED"
  | "RECENT"
  | "PRIORITY"
  | "SOURCE_LIMIT"
  | "TOTAL_BUDGET"
  | "RETRIEVABLE_DEFERRED"
  | "STALE"
  | "SENSITIVE"
  | "COMPACTED"
  | "OPEN_PROTOCOL_UNIT";

export interface ContextItemDecision {
  readonly itemId: ContextItemId;
  readonly disposition: ContextItemDisposition;
  readonly reason: ContextItemDecisionReason;
  readonly tokenEstimate: number;
}

export interface ContextPlan {
  readonly selectedItems: readonly ContextItem[];
  readonly decisions: readonly ContextItemDecision[];
  readonly budget: ContextBudgetSnapshot;
  readonly pressure: ContextPressureState;
  readonly requiresCompaction: boolean;
  readonly historySelectionPressure: boolean;
}

export interface ContextPolicy {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly requestOverhead: ContextRequestOverhead;
  readonly effectiveInputLimitTokens: number;
  readonly proactiveCompactionRatio: number;
  readonly emergencyCompactionRatio: number;
  readonly proactiveCompactionTokens: number;
  readonly emergencyCompactionTokens: number;
  readonly targetRecentTailTokens: number;
  readonly minRecentTailTokens: number;
  readonly targetPostCompactionTokens?: number;
  readonly allowCurrentTurnPrefix?: boolean;
  readonly workingSet?: ContextWorkingSetPolicy;
  readonly deepCompaction?: DeepCompactionPolicy;
  readonly requestHeadroom?: ContextRequestHeadroomPolicy;
  readonly observationPolicy: ToolObservationPolicySnapshot;
  readonly conversationCapTokens: number;
  readonly sourceLimits: Readonly<Record<string, number>>;
  readonly elasticPoolTokens: number;
  /** Whether crossing the frozen proactive trigger starts a compaction attempt. */
  readonly proactiveCompaction: { readonly enabled: boolean };
}

const DEFAULTS = {
  safetyReserveTokens: 512,
  proactiveCompactionRatio: 0.75,
  emergencyCompactionRatio: 0.9,
  targetRecentTailTokensCap: 20_000,
  targetRecentTailRatio: 0.35,
  minRecentTailTokensCap: 8_000,
  minRecentTailRatio: 0.15,
  maxSingleObservationTokensCap: 8_192,
  maxSingleObservationRatio: 0.1,
  maxObservationBatchTokensCap: 16_384,
  maxObservationBatchRatio: 0.22,
  conversationCapTokens: 12_000,
} as const;

/**
 * The input budget could not be established at all.
 *
 * ```text
 * window 600 · output reserve 128 · safety reserve 6 · request overhead 1 900  → no positive budget
 * ```
 *
 * This is a distinct, typed condition rather than a bare `RangeError` for one reason: it is the only
 * failure in this family that a *host configuration* can cause (a model whose window cannot hold its
 * own Tool schema), and a Run that fails here must be diagnosable as pressure accounting. A plain
 * `RangeError` carries no stage a classifier can read without parsing the message, and parsing
 * messages is how a diagnosis becomes confidently wrong after a wording change.
 *
 * It still extends `RangeError`, so every existing caller that treats it as a range violation keeps
 * working unchanged.
 */
export class ContextPressureAccountingError extends RangeError {
  readonly code = "CONTEXT_PRESSURE_ACCOUNTING_FAILED" as const;
  readonly stage = "pressure_accounting" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextPressureAccountingError";
  }
}

/** Resolve the per-Run reserves and effective message-input budget once. */
export function resolveAdaptiveContextBudget(
  input: AdaptiveContextBudgetInput,
): AdaptiveContextBudget {
  assertPositiveSafeInteger(input.contextWindowTokens, "contextWindowTokens");
  assertPositiveSafeInteger(input.maxOutputTokens, "maxOutputTokens");
  assertNonNegativeSafeInteger(input.requestOverheadTokens, "requestOverheadTokens");
  if (input.configuredOutputCeiling !== undefined) {
    assertPositiveSafeInteger(input.configuredOutputCeiling, "configuredOutputCeiling");
  }

  const preferredOutputCeiling = Math.min(
    input.configuredOutputCeiling ?? input.maxOutputTokens,
    input.maxOutputTokens,
  );
  const outputReserveTokens = Math.min(
    preferredOutputCeiling,
    16_384,
    Math.max(1, Math.floor(input.contextWindowTokens * 0.08)),
  );
  const safetyReserveTokens = Math.min(
    4_096,
    Math.max(1, Math.floor(input.contextWindowTokens * 0.01)),
  );
  const effectiveInputLimitTokens =
    input.contextWindowTokens -
    outputReserveTokens -
    safetyReserveTokens -
    input.requestOverheadTokens;
  if (effectiveInputLimitTokens <= 0) {
    throw new ContextPressureAccountingError(
      "Context reserves and request overhead leave no positive input budget.",
    );
  }

  return Object.freeze({
    outputReserveTokens,
    safetyReserveTokens,
    preferredOutputCeiling,
    effectiveInputLimitTokens,
  });
}

export function createContextPolicy(input: ContextPolicyInput): ContextPolicy {
  const options = input.options ?? {};
  const resolvedRequestOverhead =
    input.requestOverhead ??
    createContextRequestOverheadEstimator().estimate({
      model: input.model,
      tools: input.tools ?? [],
    });
  assertContextRequestOverhead(resolvedRequestOverhead);
  const requestOverhead = Object.freeze({ ...resolvedRequestOverhead });
  const contextWindowTokens = input.model.limits.contextWindowTokens;
  const maxOutputTokens = input.model.limits.maxOutputTokens;
  const outputReserveTokens = options.outputReserveTokens ?? maxOutputTokens;
  const safetyReserveTokens = options.safetyReserveTokens ?? DEFAULTS.safetyReserveTokens;
  assertNonNegativeSafeInteger(outputReserveTokens, "outputReserveTokens");
  assertNonNegativeSafeInteger(safetyReserveTokens, "safetyReserveTokens");
  const effectiveInputLimitTokens =
    contextWindowTokens - outputReserveTokens - safetyReserveTokens - requestOverhead.totalTokens;
  if (outputReserveTokens >= contextWindowTokens || effectiveInputLimitTokens <= 0) {
    throw new ContextPressureAccountingError(
      "Context reserves and request overhead leave no positive input budget.",
    );
  }

  const proactiveCompactionRatio =
    options.proactiveCompactionRatio ?? DEFAULTS.proactiveCompactionRatio;
  const emergencyCompactionRatio =
    options.emergencyCompactionRatio ?? DEFAULTS.emergencyCompactionRatio;
  assertRatio(proactiveCompactionRatio, "proactiveCompactionRatio");
  assertRatio(emergencyCompactionRatio, "emergencyCompactionRatio");
  if (proactiveCompactionRatio >= emergencyCompactionRatio)
    throw new RangeError("Proactive pressure must be below emergency pressure.");

  const targetRecentTailRatio = options.targetRecentTailRatio ?? DEFAULTS.targetRecentTailRatio;
  const minRecentTailRatio = options.minRecentTailRatio ?? DEFAULTS.minRecentTailRatio;
  const maxSingleObservationRatio =
    options.maxSingleObservationRatio ?? DEFAULTS.maxSingleObservationRatio;
  const maxObservationBatchRatio =
    options.maxObservationBatchRatio ?? DEFAULTS.maxObservationBatchRatio;
  assertRatio(targetRecentTailRatio, "targetRecentTailRatio");
  assertRatio(minRecentTailRatio, "minRecentTailRatio");
  assertRatio(maxSingleObservationRatio, "maxSingleObservationRatio");
  assertRatio(maxObservationBatchRatio, "maxObservationBatchRatio");

  const targetRecentTailTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    targetRecentTailRatio,
    options.targetRecentTailTokensCap ?? DEFAULTS.targetRecentTailTokensCap,
  );
  const baseMinRecentTailTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    minRecentTailRatio,
    options.minRecentTailTokensCap ?? DEFAULTS.minRecentTailTokensCap,
  );
  const workingSet = options.workingSet;
  const requestHeadroom = options.requestHeadroom;
  const deepCompaction = options.deepCompaction;
  if (workingSet !== undefined && requestHeadroom !== undefined) {
    throw new RangeError(
      "A Context policy cannot be frozen against both a working set and headroom.",
    );
  }
  if (deepCompaction !== undefined) {
    assertRatio(deepCompaction.triggerRatio, "deepCompaction.triggerRatio");
    assertPositiveSafeInteger(deepCompaction.recentTokens, "deepCompaction.recentTokens");
    assertPositiveSafeInteger(
      deepCompaction.checkpointMaxTokens,
      "deepCompaction.checkpointMaxTokens",
    );
    assertNonNegativeSafeInteger(deepCompaction.boundaryTokens, "deepCompaction.boundaryTokens");
  }
  if (workingSet !== undefined) assertWorkingSet(workingSet, effectiveInputLimitTokens);
  if (requestHeadroom !== undefined) {
    assertPositiveSafeInteger(
      requestHeadroom.expectedGrowthTokens,
      "requestHeadroom.expectedGrowthTokens",
    );
    if (requestHeadroom.postCompactionRatio !== undefined) {
      assertRatio(requestHeadroom.postCompactionRatio, "requestHeadroom.postCompactionRatio");
    }
    if (requestHeadroom.expectedGrowthTokens >= effectiveInputLimitTokens) {
      throw new RangeError("Expected growth must leave a positive input budget.");
    }
  }
  const targetPostCompactionTokens =
    deepCompaction !== undefined
      ? Math.min(
          effectiveInputLimitTokens,
          deepCompaction.recentTokens +
            deepCompaction.checkpointMaxTokens +
            deepCompaction.boundaryTokens,
        )
      : requestHeadroom !== undefined
        ? Math.max(
            1,
            Math.floor(effectiveInputLimitTokens * (requestHeadroom.postCompactionRatio ?? 0.8)),
          )
        : workingSet === undefined
          ? Math.floor(effectiveInputLimitTokens * 0.8)
          : Math.max(1, Math.floor(workingSet.targetTokens * workingSet.postCompactionRatio));
  const boundedTargetRecentTailTokens = Math.min(
    targetRecentTailTokens,
    targetPostCompactionTokens,
  );
  const minRecentTailTokens = Math.min(baseMinRecentTailTokens, boundedTargetRecentTailTokens);
  const emergencyCompactionTokens =
    requestHeadroom !== undefined
      ? // With headroom the emergency band is the real boundary: the input no longer fits next to
        // this turn's output allowance. A 90% band would declare an emergency before the request is
        // actually impossible, which is a fixed quota by another name.
        effectiveInputLimitTokens
      : Math.floor(effectiveInputLimitTokens * emergencyCompactionRatio);
  const proactiveCompactionTokens =
    requestHeadroom !== undefined
      ? Math.max(
          1,
          Math.min(
            effectiveInputLimitTokens - requestHeadroom.expectedGrowthTokens,
            // A ratio band tidies the history while there is still room, instead of waiting until
            // the next turn cannot fit. Absent means the historical "last possible moment" rule.
            deepCompaction !== undefined
              ? Math.floor(effectiveInputLimitTokens * deepCompaction.triggerRatio)
              : requestHeadroom.proactiveRatio === undefined
                ? Number.MAX_SAFE_INTEGER
                : Math.floor(effectiveInputLimitTokens * requestHeadroom.proactiveRatio),
          ),
        )
      : workingSet === undefined
        ? Math.floor(effectiveInputLimitTokens * proactiveCompactionRatio)
        : Math.max(1, Math.floor(workingSet.targetTokens * workingSet.triggerRatio));
  if (proactiveCompactionTokens >= emergencyCompactionTokens) {
    throw new RangeError("Proactive compaction threshold must remain below emergency pressure.");
  }
  /*
   * A compaction that keeps more than half of the trigger band frees less than the summary costs.
   *
   * `proactive` is "compact when the estimate reaches here" and the recent tail is "what stays
   * verbatim afterwards", so `2 × tail ≥ proactive` describes a policy whose whole purpose is
   * defeated before it runs: the largest legal fold would still retain most of the input. Catching
   * it at construction keeps a misconfigured Run from spending a summarisation call and a full
   * prefix re-read to learn the same thing at runtime.
   *
   * Only the headroom band is checked. A working set or a legacy policy can carry a tail larger
   * than its trigger for reasons of its own, and those paths keep their historical behaviour.
   */
  if (
    requestHeadroom !== undefined &&
    proactiveCompactionTokens > targetRecentTailTokens &&
    targetRecentTailTokens * 2 >= proactiveCompactionTokens
  ) {
    throw new RangeError(
      "Recent tail must be below half of the proactive compaction threshold; compaction would have no gain.",
    );
  }
  const maxSingleObservationTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    maxSingleObservationRatio,
    options.maxSingleObservationTokensCap ?? DEFAULTS.maxSingleObservationTokensCap,
  );
  const maxObservationBatchTokens = boundedRatioCap(
    effectiveInputLimitTokens,
    maxObservationBatchRatio,
    options.maxObservationBatchTokensCap ?? DEFAULTS.maxObservationBatchTokensCap,
  );
  if (
    minRecentTailTokens > boundedTargetRecentTailTokens ||
    maxSingleObservationTokens < 1 ||
    maxObservationBatchTokens < 1
  ) {
    throw new RangeError("Context policy cannot allocate a bounded tail and observation budget.");
  }
  const conversationCapTokens = options.conversationCapTokens ?? DEFAULTS.conversationCapTokens;
  assertNonNegativeSafeInteger(conversationCapTokens, "conversationCapTokens");
  const sourceLimits = freezeSourceLimits(options.sourceLimits);
  return Object.freeze({
    contextWindowTokens,
    maxOutputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    requestOverhead,
    effectiveInputLimitTokens,
    proactiveCompactionRatio,
    emergencyCompactionRatio,
    proactiveCompactionTokens,
    emergencyCompactionTokens,
    targetRecentTailTokens: boundedTargetRecentTailTokens,
    minRecentTailTokens,
    targetPostCompactionTokens,
    // A HEADROOM_V1 Run can spend its entire lifetime inside one open conversation turn: each
    // model/tool exchange extends the user's still-active turn. Without this protocol-safe prefix
    // cut, such a Run has no closed turn to compact and reaches CONTEXT_EXHAUSTED even though old
    // completed Tool batches could be removed safely. Legacy policies retain their historical
    // boundary rule; only the explicit headroom policy opts into the already-validated split.
    allowCurrentTurnPrefix: workingSet?.allowCurrentTurnPrefix ?? requestHeadroom !== undefined,
    ...(workingSet === undefined ? {} : { workingSet: Object.freeze({ ...workingSet }) }),
    ...(deepCompaction === undefined
      ? {}
      : { deepCompaction: Object.freeze({ ...deepCompaction }) }),
    ...(requestHeadroom === undefined
      ? {}
      : { requestHeadroom: Object.freeze({ ...requestHeadroom }) }),
    observationPolicy: Object.freeze({ maxSingleObservationTokens, maxObservationBatchTokens }),
    conversationCapTokens,
    sourceLimits,
    elasticPoolTokens: Math.max(0, effectiveInputLimitTokens - boundedTargetRecentTailTokens),
    proactiveCompaction: Object.freeze({
      enabled: options.proactiveCompactionEnabled ?? true,
    }),
  });
}

function assertWorkingSet(
  workingSet: ContextWorkingSetPolicy,
  effectiveInputLimitTokens: number,
): void {
  assertPositiveSafeInteger(workingSet.targetTokens, "workingSet.targetTokens");
  if (workingSet.targetTokens > effectiveInputLimitTokens) {
    throw new RangeError("Working-set targetTokens must not exceed the effective input budget.");
  }
  assertRatio(workingSet.triggerRatio, "workingSet.triggerRatio");
  assertRatio(workingSet.postCompactionRatio, "workingSet.postCompactionRatio");
  assertNonNegativeSafeInteger(workingSet.cooldownTurns, "workingSet.cooldownTurns");
  if (typeof workingSet.allowCurrentTurnPrefix !== "boolean") {
    throw new TypeError("workingSet.allowCurrentTurnPrefix must be boolean.");
  }
}

export function classifyContextPressure(
  estimatedInputTokens: number,
  policy: ContextPolicy,
): ContextPressureState {
  if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) {
    throw new RangeError("estimatedInputTokens must be a non-negative safe integer.");
  }
  if (estimatedInputTokens >= policy.emergencyCompactionTokens) return "EMERGENCY";
  if (estimatedInputTokens >= policy.proactiveCompactionTokens) return "PROACTIVE";
  return "NORMAL";
}

function boundedRatioCap(limit: number, ratio: number, cap: number): number {
  assertNonNegativeSafeInteger(cap, "context policy cap");
  return Math.min(cap, Math.floor(limit * ratio));
}

function freezeSourceLimits(
  value: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const limits: Record<string, number> = {};
  for (const [source, limit] of Object.entries(value ?? {})) {
    if (source.trim().length === 0)
      throw new RangeError("Context source limit id must not be empty.");
    assertNonNegativeSafeInteger(limit, `sourceLimits.${source}`);
    limits[source] = limit;
  }
  return Object.freeze(limits);
}

function assertRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1)
    throw new RangeError(`${label} must be between 0 and 1.`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RangeError(`${label} must be a non-negative safe integer.`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new RangeError(`${label} must be a positive safe integer.`);
}

export type { ToolObservationPolicySnapshot };
