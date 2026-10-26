import { ContextPressureAccountingError } from "./context-policy.js";

/**
 * The one place a turn's real output allowance is decided.
 *
 * ```text
 * W  the effective window of the model this turn actually resolved to
 * P  the full prepared input: messages, Tool schema, envelope and native replay
 * O  the output allowance this turn actually requests on the wire
 * S  safety reserve for estimator and protocol error
 * G  the growth the next turn is expected to add (bounded tool results)
 *
 * P + O + S <= W        the hard request constraint
 * W - P - O - S >= G    the preparation condition
 * ```
 *
 * The previous implementation froze a working set (96 000 tokens, 75% trigger), which turned a
 * capacity question into a fixed low quota: a Run with a one-million-token window reorganized its
 * history at roughly 72 000 tokens no matter how much room it really had. Nothing here uses a
 * fixed input quota. `O` is derived per turn from the space that is actually left, the history is
 * kept whole while it fits, and a reorganization happens only when the *remaining* room can no
 * longer absorb the next turn's growth.
 *
 * `G` is charged exactly once. It is not a second output reservation: it describes what a future
 * Tool result may add, so it must not be included in `O` or counted again in `S`.
 */

export const TURN_BUDGET_ALGORITHM = "HEADROOM_V1" as const;
export type TurnBudgetAlgorithm = typeof TURN_BUDGET_ALGORITHM;

export interface DeepCompactionPolicyV1 {
  readonly version: "DEEP_COMPACTION_V1";
  readonly triggerRatio: number;
  readonly recentTokens: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
}

export interface DeepCompactionPolicyV2 {
  readonly version: "DEEP_COMPACTION_V2";
  readonly triggerRatio: number;
  readonly recentRatio: number;
  readonly minimumReleaseRatio: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
}

export type DeepCompactionPolicy = DeepCompactionPolicyV1 | DeepCompactionPolicyV2;

/**
 * Initial elastic defaults, centralized so representative window cases can calibrate them
 * without changing historic V1 snapshots. The 8% tail and 70% release are starting points,
 * not claims about the final input size or provider cache rate.
 */
export const DEEP_COMPACTION_V2_DEFAULTS = Object.freeze({
  version: "DEEP_COMPACTION_V2",
  triggerRatio: 0.9,
  recentRatio: 0.08,
  minimumReleaseRatio: 0.7,
  checkpointMaxTokens: 8_192,
  boundaryTokens: 4_096,
} as const);

/** Versioned, Run-frozen parameters of the headroom algorithm. */
export interface TurnBudgetPolicyV3 {
  readonly version: "TURN_BUDGET_V3";
  readonly algorithm: TurnBudgetAlgorithm;
  /** A turn never asks for less than this while the window can still carry it. */
  readonly minOutputTokens: number;
  /** The allowance a turn asks for when nothing forces a different number. */
  readonly preferredOutputTokens: number;
  /** Estimator and protocol error margin. */
  readonly safetyTokens: number;
  /** Expected net input growth of the next turn. */
  readonly expectedGrowthTokens: number;
  /** How much of the input budget a reorganization tries to keep. */
  readonly postCompactionRatio: number;
  /**
   * Fraction of the usable input budget at which history is reorganized proactively.
   *
   * Absent on Runs frozen before this field existed: they keep the historical rule, which waits
   * until the remaining room can no longer absorb the next turn's growth (about 97% of the usable
   * budget on a 1M window). New Runs freeze the ratio so a long session is tidied while there is
   * still room, the way Codex (90%) and DeepSeek Harness (80%) do.
   */
  readonly proactiveRatio?: number | undefined;
}

/** V4 replaces the fixed post-compaction ratio with explicit retained-content budgets. */
export interface TurnBudgetPolicyV4 {
  readonly version: "TURN_BUDGET_V4";
  readonly algorithm: TurnBudgetAlgorithm;
  readonly minOutputTokens: number;
  readonly preferredOutputTokens: number;
  readonly safetyTokens: number;
  readonly expectedGrowthTokens: number;
  readonly deepCompaction: DeepCompactionPolicy;
}

export type TurnBudgetPolicy = TurnBudgetPolicyV3 | TurnBudgetPolicyV4;

export interface TurnBudgetPolicyInput {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** A host or user generation preference. It wins over the preferred allowance. */
  readonly configuredOutputCeiling?: number;
}

/**
 * Defaults, and where each number comes from.
 *
 * ```text
 * preferredOutputTokens 16 384   the existing adaptive helper's allowance; kept as an allowance
 *                                target, never as a reserve, so it cannot shrink the input budget
 *                                the way the previous `outputReserveTokens = maxOutputTokens` did
 * minOutputTokens        2 048   one complete Tool call plus a short explanation; the smallest
 *                                output that can still make progress in a single turn
 * safetyTokens     512…4 096     protocol envelope plus a positive estimator error margin,
 *                                scaled at 0.5% of the window
 * expectedGrowthTokens 1k…16 384 next turn's bounded Tool-result growth, scaled at 2% of the window
 * postCompactionRatio      0.8   keep as much original history as the freed budget allows
 * ```
 *
 * These are experimental starting points, not user-approved production values: the calibration
 * record in the diagnostics pack marks real-model quality as NOT_MEASURED. They are frozen into
 * each new Run so a later change cannot silently re-budget a Run that is already running.
 */
export const HEADROOM_V1_DEFAULTS = Object.freeze({
  preferredOutputTokens: 16_384,
  minOutputTokens: 2_048,
  safetyTokensFloor: 512,
  safetyTokensCeiling: 4_096,
  safetyTokenRatio: 0.005,
  expectedGrowthTokensFloor: 1_024,
  expectedGrowthTokensCeiling: 16_384,
  expectedGrowthRatio: 0.02,
  postCompactionRatio: 0.8,
  proactiveRatio: 0.9,
} as const);

export function resolveTurnBudgetPolicy(input: TurnBudgetPolicyInput): TurnBudgetPolicyV3 {
  assertPositiveSafeInteger(input.contextWindowTokens, "contextWindowTokens");
  assertPositiveSafeInteger(input.maxOutputTokens, "maxOutputTokens");
  if (input.configuredOutputCeiling !== undefined) {
    assertPositiveSafeInteger(input.configuredOutputCeiling, "configuredOutputCeiling");
  }
  const maxOutputTokens = input.maxOutputTokens;
  // An explicit generation preference is a ceiling, not a suggestion: it also lowers the floor so a
  // host that asks for a short answer never receives a larger one than it asked for.
  const configured = input.configuredOutputCeiling;
  const minOutputTokens = Math.max(
    1,
    Math.min(
      configured === undefined
        ? HEADROOM_V1_DEFAULTS.minOutputTokens
        : Math.min(HEADROOM_V1_DEFAULTS.minOutputTokens, configured),
      maxOutputTokens,
    ),
  );
  const preferredOutputTokens = Math.max(
    minOutputTokens,
    Math.min(configured ?? HEADROOM_V1_DEFAULTS.preferredOutputTokens, maxOutputTokens),
  );
  const safetyTokens = Math.min(
    HEADROOM_V1_DEFAULTS.safetyTokensCeiling,
    Math.max(
      HEADROOM_V1_DEFAULTS.safetyTokensFloor,
      Math.ceil(input.contextWindowTokens * HEADROOM_V1_DEFAULTS.safetyTokenRatio),
    ),
  );
  const remainingForGrowth =
    input.contextWindowTokens -
    safetyTokens -
    minOutputTokens -
    Math.min(HEADROOM_V1_DEFAULTS.preferredOutputTokens, maxOutputTokens);
  if (remainingForGrowth < 1) {
    throw new ContextPressureAccountingError(
      "Context window cannot carry the minimum output allowance and safety reserve.",
    );
  }
  const expectedGrowthTokens = Math.max(
    1,
    Math.min(
      HEADROOM_V1_DEFAULTS.expectedGrowthTokensCeiling,
      Math.max(
        HEADROOM_V1_DEFAULTS.expectedGrowthTokensFloor,
        Math.ceil(input.contextWindowTokens * HEADROOM_V1_DEFAULTS.expectedGrowthRatio),
      ),
      remainingForGrowth,
    ),
  );
  return Object.freeze({
    version: "TURN_BUDGET_V3" as const,
    algorithm: TURN_BUDGET_ALGORITHM,
    minOutputTokens,
    preferredOutputTokens,
    safetyTokens,
    expectedGrowthTokens,
    postCompactionRatio: HEADROOM_V1_DEFAULTS.postCompactionRatio,
    proactiveRatio: HEADROOM_V1_DEFAULTS.proactiveRatio,
  });
}

export interface OutputAllowanceInput {
  readonly policy: TurnBudgetPolicy;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** Full input actually intended for the request, including request overhead. */
  readonly fullInputTokens: number;
  readonly configuredOutputCeiling?: number;
}

export interface OutputAllowance {
  readonly tokens: number;
  /**
   * The window could not carry even the minimum allowance next to this input.
   *
   * A limited turn still runs at the floor, but the caller must treat the history as the thing that
   * has to change: compacting it is the only way the next turn can ask for a real output budget.
   */
  readonly limited: boolean;
}

/**
 * Resolve this turn's output allowance and say whether the window forced the floor.
 *
 * ```text
 * room         = W - S - G - P
 * allowance    = clamp(O_min, O_preferred, room)
 * ```
 *
 * Clamping at `room` is what makes a large window pay for itself: with a small input the allowance
 * rises to the preferred value, and with a large input the allowance shrinks before any history is
 * touched, which is the ordering Q07 asked for. A window that cannot even carry `O_min` still
 * returns `O_min`; the caller's hard check then decides whether the input has to be reorganized.
 */
export function planOutputAllowance(input: OutputAllowanceInput): OutputAllowance {
  assertPositiveSafeInteger(input.contextWindowTokens, "contextWindowTokens");
  assertPositiveSafeInteger(input.maxOutputTokens, "maxOutputTokens");
  assertNonNegativeSafeInteger(input.fullInputTokens, "fullInputTokens");
  const configuredCeiling =
    input.configuredOutputCeiling === undefined
      ? undefined
      : Math.min(input.configuredOutputCeiling, input.maxOutputTokens);
  const ceiling = Math.min(
    configuredCeiling ?? input.policy.preferredOutputTokens,
    input.maxOutputTokens,
  );
  const floor = Math.min(input.policy.minOutputTokens, ceiling);
  const room =
    input.contextWindowTokens -
    input.policy.safetyTokens -
    input.policy.expectedGrowthTokens -
    input.fullInputTokens;
  if (room < floor) return Object.freeze({ tokens: floor, limited: true });
  return Object.freeze({ tokens: Math.min(ceiling, room), limited: false });
}

export function resolveOutputAllowance(input: OutputAllowanceInput): number {
  return planOutputAllowance(input).tokens;
}

export interface RequestHeadroomInput {
  readonly windowTokens: number;
  /** Full input including request overhead. */
  readonly fullInputTokens: number;
  readonly outputAllowanceTokens: number;
  readonly safetyTokens: number;
  readonly expectedGrowthTokens: number;
}

export interface RequestHeadroom {
  /** `W - P - O - S`; negative means the request itself does not fit. */
  readonly remainingTokens: number;
  readonly fitsCurrentRequest: boolean;
  /** True only when the current request fits but leaves less room than the next turn needs. */
  readonly needsPreparation: boolean;
}

export function computeRequestHeadroom(input: RequestHeadroomInput): RequestHeadroom {
  assertPositiveSafeInteger(input.windowTokens, "windowTokens");
  assertNonNegativeSafeInteger(input.fullInputTokens, "fullInputTokens");
  assertPositiveSafeInteger(input.outputAllowanceTokens, "outputAllowanceTokens");
  assertNonNegativeSafeInteger(input.safetyTokens, "safetyTokens");
  assertPositiveSafeInteger(input.expectedGrowthTokens, "expectedGrowthTokens");
  const remainingTokens =
    input.windowTokens - input.fullInputTokens - input.outputAllowanceTokens - input.safetyTokens;
  const fitsCurrentRequest = remainingTokens >= 0;
  return Object.freeze({
    remainingTokens,
    fitsCurrentRequest,
    needsPreparation: !fitsCurrentRequest || remainingTokens < input.expectedGrowthTokens,
  });
}

export type TurnBudgetDecisionKind = "KEEP" | "ADJUST_OUTPUT" | "PREPARE_HISTORY";

/** Why each number has the value it has, kept with the decision rather than reconstructed later. */
export interface BoundedBudgetSources {
  readonly window: "MODEL_LIMITS";
  readonly output: "EXPLICIT_SETTING" | "PREFERRED_ALLOWANCE" | "AVAILABLE_ROOM";
  readonly safety: "HEADROOM_V1_SAFETY";
  readonly growth: "HEADROOM_V1_EXPECTED_GROWTH";
}

/** One turn's frozen budget decision; `TURN_BUDGET_DECISION_V1` is the only supported version. */
export interface TurnBudgetDecision {
  readonly version: "TURN_BUDGET_DECISION_V1";
  readonly algorithm: TurnBudgetAlgorithm;
  readonly modelProfileRef: string;
  readonly preparedSurfaceDigest: string;
  readonly windowTokens: number;
  readonly inputTokens: number;
  readonly outputAllowanceTokens: number;
  readonly safetyTokens: number;
  readonly expectedGrowthTokens: number;
  readonly remainingTokens: number;
  readonly decision: TurnBudgetDecisionKind;
  readonly sources: BoundedBudgetSources;
}

export interface TurnBudgetDecisionInput {
  readonly policy: TurnBudgetPolicy;
  readonly modelProfileRef: string;
  readonly preparedSurfaceDigest: string;
  readonly windowTokens: number;
  readonly fullInputTokens: number;
  readonly outputAllowanceTokens: number;
  readonly configuredOutputCeiling?: number;
  readonly compacted: boolean;
}

export function decideTurnBudget(input: TurnBudgetDecisionInput): TurnBudgetDecision {
  const headroom = computeRequestHeadroom({
    windowTokens: input.windowTokens,
    fullInputTokens: input.fullInputTokens,
    outputAllowanceTokens: input.outputAllowanceTokens,
    safetyTokens: input.policy.safetyTokens,
    expectedGrowthTokens: input.policy.expectedGrowthTokens,
  });
  const decision: TurnBudgetDecisionKind = headroom.needsPreparation
    ? "PREPARE_HISTORY"
    : input.compacted || input.outputAllowanceTokens < input.policy.preferredOutputTokens
      ? "ADJUST_OUTPUT"
      : "KEEP";
  const ceiling = Math.min(
    input.configuredOutputCeiling ?? input.policy.preferredOutputTokens,
    input.policy.preferredOutputTokens,
  );
  const outputSource =
    input.configuredOutputCeiling !== undefined && input.configuredOutputCeiling <= ceiling
      ? "EXPLICIT_SETTING"
      : input.outputAllowanceTokens >= input.policy.preferredOutputTokens
        ? "PREFERRED_ALLOWANCE"
        : "AVAILABLE_ROOM";
  return Object.freeze({
    version: "TURN_BUDGET_DECISION_V1" as const,
    algorithm: input.policy.algorithm,
    modelProfileRef: input.modelProfileRef,
    preparedSurfaceDigest: input.preparedSurfaceDigest,
    windowTokens: input.windowTokens,
    inputTokens: input.fullInputTokens,
    outputAllowanceTokens: input.outputAllowanceTokens,
    safetyTokens: input.policy.safetyTokens,
    expectedGrowthTokens: input.policy.expectedGrowthTokens,
    remainingTokens: headroom.remainingTokens,
    decision,
    sources: Object.freeze({
      window: "MODEL_LIMITS" as const,
      output: outputSource,
      safety: "HEADROOM_V1_SAFETY" as const,
      growth: "HEADROOM_V1_EXPECTED_GROWTH" as const,
    }),
  });
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new RangeError(`${label} must be a positive safe integer.`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RangeError(`${label} must be a non-negative safe integer.`);
}
