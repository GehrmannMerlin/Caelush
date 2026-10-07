import { z } from "zod";
import { RunIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";

const ContextUsageBreakdownSchema = z
  .object({
    pinned: z.number().int().nonnegative(),
    checkpoint: z.number().int().nonnegative(),
    recentTail: z.number().int().nonnegative(),
    project: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    toolObservations: z.number().int().nonnegative(),
    memory: z.number().int().nonnegative(),
    systemTokens: z.number().int().nonnegative().optional(),
    goalTokens: z.number().int().nonnegative().optional(),
    currentUserTokens: z.number().int().nonnegative().optional(),
    relevantFileTokens: z.number().int().nonnegative().optional(),
    currentTurnTokens: z.number().int().nonnegative().optional(),
    mandatoryTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export const PromptCacheStatusSchema = z.enum(["WARM", "COLD_START", "RESET", "UNREPORTED"]);
export const PromptCacheRequestPurposeSchema = z.enum([
  "MAIN_AGENT",
  "WARMUP",
  "RETRY",
  "COMPACTION",
  "TITLE",
  "OTHER",
]);
const PromptSurfaceResetReasonSchema = z.enum([
  "INITIAL",
  "MODEL_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "STABLE_HEAD_CHANGED",
  "CACHE_SETTINGS_CHANGED",
  "COMPACTION_COMMITTED",
  "RECOVERY_INCOMPATIBLE",
]);
const SafeTokenCountSchema = z.number().int().nonnegative();
const SafeRateSchema = z.number().finite().min(0).max(1);

export const PromptCachePurposeUsageSchema = z
  .object({
    purpose: PromptCacheRequestPurposeSchema,
    requestCount: SafeTokenCountSchema,
    inputTokens: SafeTokenCountSchema,
    outputTokens: SafeTokenCountSchema,
    hitTokens: SafeTokenCountSchema,
    missTokens: SafeTokenCountSchema,
    writeTokens: SafeTokenCountSchema,
    unknownUsageCount: SafeTokenCountSchema,
  })
  .strict()
  .refine(
    (usage) => usage.unknownUsageCount <= usage.requestCount,
    "Purpose unknown usage count cannot exceed its request count.",
  );

const PromptCacheFingerprintSchema = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);

export const PromptCacheSurfaceSegmentsSchema = z
  .object({
    prefixFingerprint: PromptCacheFingerprintSchema,
    modelFingerprint: PromptCacheFingerprintSchema,
    stableHeadFingerprint: PromptCacheFingerprintSchema,
    toolCatalogFingerprint: PromptCacheFingerprintSchema,
    cacheSettingsFingerprint: PromptCacheFingerprintSchema,
    checkpointFingerprint: PromptCacheFingerprintSchema,
    recentTailFingerprint: PromptCacheFingerprintSchema,
    roleSizeVectorFingerprint: PromptCacheFingerprintSchema,
    stableHeadTokens: SafeTokenCountSchema,
    snapshotTokens: SafeTokenCountSchema,
    recentTailTokens: SafeTokenCountSchema,
    checkpointBytes: SafeTokenCountSchema,
    recentTailBytes: SafeTokenCountSchema,
    recentTailMessageCount: SafeTokenCountSchema,
  })
  .strict();

export const PromptCacheUsageSchema = z
  .object({
    status: PromptCacheStatusSchema,
    sampleCount: SafeTokenCountSchema,
    totalRequestCount: SafeTokenCountSchema,
    totalInputTokens: SafeTokenCountSchema,
    totalOutputTokens: SafeTokenCountSchema,
    hitTokens: SafeTokenCountSchema,
    missTokens: SafeTokenCountSchema,
    writeTokens: SafeTokenCountSchema,
    unknownUsageCount: SafeTokenCountSchema,
    latestHitRate: SafeRateSchema.optional(),
    rollingHitRate: SafeRateSchema.optional(),
    expectedReusablePrefixTokens: SafeTokenCountSchema,
    reusablePrefixEfficiency: SafeRateSchema.optional(),
    epochId: z.string().min(1).max(256).optional(),
    resetReason: PromptSurfaceResetReasonSchema.optional(),
    resetStepSequence: SafeTokenCountSchema.optional(),
    resetAt: TimestampMsSchema.optional(),
    lastMeasuredAt: TimestampMsSchema.optional(),
    purposes: z.array(PromptCachePurposeUsageSchema).max(6),
    surfaceSegments: PromptCacheSurfaceSegmentsSchema.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.sampleCount > usage.totalRequestCount) {
      context.addIssue({
        code: "custom",
        path: ["sampleCount"],
        message: "Prompt-cache sample count cannot exceed total requests.",
      });
    }
    if (usage.unknownUsageCount > usage.totalRequestCount) {
      context.addIssue({
        code: "custom",
        path: ["unknownUsageCount"],
        message: "Prompt-cache unknown usage count cannot exceed total requests.",
      });
    }
    if ((usage.resetStepSequence === undefined) !== (usage.resetAt === undefined)) {
      context.addIssue({
        code: "custom",
        path: [usage.resetStepSequence === undefined ? "resetStepSequence" : "resetAt"],
        message: "Prompt-cache reset step and time must be reported together.",
      });
    }
    if (
      usage.resetReason === "INITIAL" &&
      (usage.resetStepSequence !== undefined || usage.resetAt !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resetReason"],
        message: "Initial Prompt Surface creation is not a reset.",
      });
    }
    if (usage.status === "UNREPORTED") {
      for (const field of [
        "latestHitRate",
        "rollingHitRate",
        "reusablePrefixEfficiency",
      ] as const) {
        if (usage[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Unreported prompt-cache usage cannot contain a rate.",
          });
        }
      }
    }
    const seenPurposes = new Set<string>();
    for (const [index, purpose] of usage.purposes.entries()) {
      if (seenPurposes.has(purpose.purpose)) {
        context.addIssue({
          code: "custom",
          path: ["purposes", index, "purpose"],
          message: "Prompt-cache purposes must not be duplicated.",
        });
      }
      seenPurposes.add(purpose.purpose);
    }
  });

export const ContextUsagePressureStateSchema = z.enum(["NORMAL", "PROACTIVE", "EMERGENCY"]);
const ContextProfileSourceSchema = z.enum([
  "CONFIGURATION",
  "KNOWN_METADATA",
  "LEGACY_LIMITS",
  "OVERRIDE",
  "FALLBACK",
]);

export const ContextUsageProjectionSchema = z
  .object({
    runId: RunIdSchema,
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    profileSource: ContextProfileSourceSchema.optional(),
    contextWindowTokens: z.number().int().nonnegative(),
    rawContextWindowTokens: z.number().int().nonnegative().optional(),
    effectiveInputLimitTokens: z.number().int().positive(),
    estimatedInputTokens: z.number().int().nonnegative(),
    usedRatio: z.number().min(0).max(1),
    remainingTokens: z.number().int().nonnegative(),
    pressureState: ContextUsagePressureStateSchema,
    compactionCount: z.number().int().nonnegative(),
    lastCompactionAt: TimestampMsSchema.optional(),
    lastBuildAt: TimestampMsSchema.optional(),
    lastRecoveryStages: z.array(z.string().min(1)).max(32).optional(),
    breakdown: ContextUsageBreakdownSchema,
    updatedAt: TimestampMsSchema,
    lastBuildStatus: z.enum(["SUCCESS", "FAILED", "CONTEXT_EXHAUSTED"]).optional(),
    promptCache: PromptCacheUsageSchema.optional(),
  })
  .strict();

export const ContextUsageResponseSchema = ContextUsageProjectionSchema.nullable();
export type PromptCacheStatus = z.infer<typeof PromptCacheStatusSchema>;
export type PromptCacheRequestPurpose = z.infer<typeof PromptCacheRequestPurposeSchema>;
export type PromptCachePurposeUsage = z.infer<typeof PromptCachePurposeUsageSchema>;
export type PromptCacheSurfaceSegments = z.infer<typeof PromptCacheSurfaceSegmentsSchema>;
export type PromptCacheUsage = z.infer<typeof PromptCacheUsageSchema>;
export type ContextUsageProjection = z.infer<typeof ContextUsageProjectionSchema>;
export type ContextUsageResponse = z.infer<typeof ContextUsageResponseSchema>;
