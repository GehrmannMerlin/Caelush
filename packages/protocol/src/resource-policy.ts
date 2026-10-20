import { z } from "zod";
import { isSafePositiveMicroUsd, RunLimitsSchema, type RunLimits } from "./limits.js";

const safePositiveInteger = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a safe integer");

const optionalSafePositiveInteger = safePositiveInteger.optional();
const optionalSafePositiveUsd = z
  .number()
  .finite()
  .positive()
  .refine(isSafePositiveMicroUsd, "must be representable as positive safe micro-USD")
  .optional();

/**
 * Which correction discipline a Run was created under.
 *
 * ```text
 * absent                      historical V1: repeated no-progress may end in a human decision
 * AUTONOMOUS_CORRECTION_V2    repeated no-progress is help, never a gate
 * ```
 *
 * The distinction is a *behavioural contract*, not a tuning knob, so it is a version and not a set of
 * numbers: V1 reads `progress.replansBeforePause` as a pause threshold, V2 never does. Both versions
 * read the same `windowTurns`, `identicalCallNudgeThreshold` and `noProgressTurnsBeforeReplan`, so
 * every threshold still comes from the one policy the Run froze at creation.
 *
 * Absence means V1 for exactly the reason epoch fields always mean absence: a Run created before this
 * field existed was governed by V1, and a process upgrade cannot retroactively re-decide what its
 * evidence meant. Only Run creation stamps a version — see
 * `normalizeCreateRunResourcePolicy`.
 */
export const AUTONOMOUS_CORRECTION_V2 = "AUTONOMOUS_CORRECTION_V2" as const;

export const RunCorrectionVersionSchema = z.literal(AUTONOMOUS_CORRECTION_V2);
export type RunCorrectionVersion = z.infer<typeof RunCorrectionVersionSchema>;

export const RunResourcePolicySchema = z
  .object({
    mode: z.enum(["ADAPTIVE", "LEGACY_FIXED"]),
    correctionVersion: RunCorrectionVersionSchema.optional(),
    operationalLease: z
      .object({
        maxAgentTurns: safePositiveInteger,
        maxToolOperations: safePositiveInteger,
      })
      .strict(),
    batch: z.object({ maxToolCallsPerTurn: safePositiveInteger }).strict(),
    progress: z
      .object({
        windowTurns: safePositiveInteger,
        identicalCallNudgeThreshold: safePositiveInteger,
        noProgressTurnsBeforeReplan: safePositiveInteger,
        replansBeforePause: safePositiveInteger,
      })
      .strict(),
    hardLimits: z
      .object({
        maxAgentTurns: optionalSafePositiveInteger,
        maxToolCalls: optionalSafePositiveInteger,
        maxTokens: optionalSafePositiveInteger,
        maxCost: optionalSafePositiveUsd,
        maxWallClockMs: optionalSafePositiveInteger,
        maxChangedFiles: optionalSafePositiveInteger,
        maxMutationBytes: optionalSafePositiveInteger,
      })
      .strict(),
    inactivity: z
      .object({
        nudgeAfterMs: optionalSafePositiveInteger,
        pauseAfterMs: optionalSafePositiveInteger,
      })
      .strict(),
  })
  .strict();
export type RunResourcePolicy = z.infer<typeof RunResourcePolicySchema>;

/** Whether this Run corrects autonomously instead of pausing for a resource decision. */
export function isAutonomousCorrectionV2(policy: RunResourcePolicy): boolean {
  return policy.correctionVersion === AUTONOMOUS_CORRECTION_V2;
}

export interface EnterpriseResourceHardLimits {
  readonly maxAgentTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly maxCost?: number;
  readonly maxWallClockMs?: number;
  readonly maxChangedFiles?: number;
  readonly maxMutationBytes?: number;
}

export type CreateRunResourcePolicyInput = {
  readonly resourcePolicy?: unknown;
  readonly limits?: unknown;
};

export function createLegacyRunResourcePolicy(limits: RunLimits): RunResourcePolicy {
  const parsed = RunLimitsSchema.parse(limits);
  return RunResourcePolicySchema.parse({
    mode: "LEGACY_FIXED",
    operationalLease: {
      maxAgentTurns: parsed.maxSteps,
      maxToolOperations: parsed.maxToolCalls,
    },
    batch: { maxToolCallsPerTurn: parsed.maxToolCalls },
    progress: defaultProgressPolicy(),
    hardLimits: {
      maxAgentTurns: parsed.maxSteps,
      maxToolCalls: parsed.maxToolCalls,
      ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
      ...(parsed.maxCost === undefined ? {} : { maxCost: parsed.maxCost }),
      maxWallClockMs: parsed.timeoutMs,
    },
    inactivity: {},
  });
}

/**
 * Normalize a create-Run payload into the policy this Run will be governed by.
 *
 * ```text
 * creation      freezes a correction version, explicitly, into the Run row
 * decoding      reads what the row says, and absence means V1
 * ```
 *
 * This function is the *only* place a new Run's correction discipline is decided, which is what makes
 * the discipline checkable: a Run either carries `AUTONOMOUS_CORRECTION_V2` because it was created
 * here, or it does not because it was created before the field existed. There is deliberately no
 * environment variable and no process default that could re-interpret a Run already in flight.
 *
 * Rolling back the default is therefore a one-line change here that affects **new** Runs only.
 * Runs already stamped V2 keep decoding as V2, because the alternative — recomputing an old Run's
 * history under a different pause rule — would change the meaning of evidence it already gathered.
 */
export function normalizeCreateRunResourcePolicy(
  input: CreateRunResourcePolicyInput,
  enterprise?: EnterpriseResourceHardLimits,
): RunResourcePolicy {
  const hasPolicy = input.resourcePolicy !== undefined;
  const hasLimits = input.limits !== undefined;
  if (hasPolicy === hasLimits) {
    throw new Error("Create Run must provide exactly one resourcePolicy or limits.");
  }
  const policy = hasPolicy
    ? RunResourcePolicySchema.parse(input.resourcePolicy)
    : createLegacyRunResourcePolicy(RunLimitsSchema.parse(input.limits));
  return applyEnterpriseHardLimits(withFrozenCorrectionVersion(policy), enterprise);
}

/** Stamp the creation-time correction version when the caller did not name one. */
function withFrozenCorrectionVersion(policy: RunResourcePolicy): RunResourcePolicy {
  if (policy.correctionVersion !== undefined) return policy;
  return { ...policy, correctionVersion: AUTONOMOUS_CORRECTION_V2 };
}

export function applyEnterpriseHardLimits(
  policy: RunResourcePolicy,
  enterprise?: EnterpriseResourceHardLimits,
): RunResourcePolicy {
  if (enterprise === undefined) return RunResourcePolicySchema.parse(policy);
  const hardLimits = {
    ...policy.hardLimits,
    ...intersection("maxAgentTurns", policy.hardLimits.maxAgentTurns, enterprise.maxAgentTurns),
    ...intersection("maxToolCalls", policy.hardLimits.maxToolCalls, enterprise.maxToolCalls),
    ...intersection("maxTokens", policy.hardLimits.maxTokens, enterprise.maxTokens),
    ...intersection("maxCost", policy.hardLimits.maxCost, enterprise.maxCost),
    ...intersection("maxWallClockMs", policy.hardLimits.maxWallClockMs, enterprise.maxWallClockMs),
    ...intersection(
      "maxChangedFiles",
      policy.hardLimits.maxChangedFiles,
      enterprise.maxChangedFiles,
    ),
    ...intersection(
      "maxMutationBytes",
      policy.hardLimits.maxMutationBytes,
      enterprise.maxMutationBytes,
    ),
  };
  return RunResourcePolicySchema.parse({ ...policy, hardLimits });
}

export function compatibilityLimitsForResourcePolicy(policy: RunResourcePolicy): RunLimits {
  const hard = policy.hardLimits;
  return RunLimitsSchema.parse({
    maxSteps: hard.maxAgentTurns ?? Number.MAX_SAFE_INTEGER,
    maxToolCalls: hard.maxToolCalls ?? Number.MAX_SAFE_INTEGER,
    timeoutMs: hard.maxWallClockMs ?? Number.MAX_SAFE_INTEGER,
    ...(hard.maxTokens === undefined ? {} : { maxTokens: hard.maxTokens }),
    ...(hard.maxCost === undefined ? {} : { maxCost: hard.maxCost }),
  });
}

function defaultProgressPolicy() {
  return {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  } as const;
}

function intersection<K extends keyof EnterpriseResourceHardLimits>(
  key: K,
  requested: RunResourcePolicy["hardLimits"][K],
  enterprise: EnterpriseResourceHardLimits[K],
): Partial<Pick<RunResourcePolicy["hardLimits"], K>> {
  if (requested === undefined && enterprise === undefined) return {};
  if (requested === undefined)
    return { [key]: enterprise } as Partial<Pick<RunResourcePolicy["hardLimits"], K>>;
  if (enterprise === undefined)
    return { [key]: requested } as Partial<Pick<RunResourcePolicy["hardLimits"], K>>;
  return { [key]: Math.min(requested, enterprise) } as Partial<
    Pick<RunResourcePolicy["hardLimits"], K>
  >;
}
