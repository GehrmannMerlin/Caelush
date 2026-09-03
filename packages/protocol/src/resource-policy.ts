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

export const RunResourcePolicySchema = z
  .object({
    mode: z.enum(["ADAPTIVE", "LEGACY_FIXED"]),
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
  return applyEnterpriseHardLimits(policy, enterprise);
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
