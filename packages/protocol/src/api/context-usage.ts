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
  "VERIFICATION_LLM",
  "CONTEXT_COMPACTION",
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
const SafeTokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafeRateSchema = z.number().finite().min(0).max(1);
const CacheRateViewSchema = z
  .object({
    requestCount: SafeTokenCountSchema,
    hitTokens: SafeTokenCountSchema,
    accountedTokens: SafeTokenCountSchema,
    hitRate: SafeRateSchema.optional(),
  })
  .strict()
  .superRefine((view, context) => {
    if ((view.accountedTokens === 0) !== (view.hitRate === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["hitRate"],
        message: "A cache rate is reported only when the accounted token denominator is positive.",
      });
    }
    if (view.hitTokens > view.accountedTokens) {
      context.addIssue({
        code: "custom",
        path: ["hitTokens"],
        message: "Cache hit tokens cannot exceed the accounted hit/miss token total.",
      });
    }
    if (view.accountedTokens > 0 && view.requestCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["requestCount"],
        message: "Reported cache tokens require at least one complete request.",
      });
    }
    if (view.hitRate !== undefined && view.hitRate !== view.hitTokens / view.accountedTokens) {
      context.addIssue({
        code: "custom",
        path: ["hitRate"],
        message: "Cache hit rate must match its provider-reported hit/miss token counts.",
      });
    }
    if (!Number.isSafeInteger(view.hitTokens + (view.accountedTokens - view.hitTokens))) {
      context.addIssue({
        code: "custom",
        path: ["accountedTokens"],
        message: "Cache accounting token totals must remain safe integers.",
      });
    }
  });

export const CacheMetricsV2Schema = z
  .object({
    fullRun: z
      .object({ mainAgent: CacheRateViewSchema, allPurposes: CacheRateViewSchema })
      .strict(),
    warm: z.object({ mainAgent: CacheRateViewSchema, allPurposes: CacheRateViewSchema }).strict(),
    rolling: z
      .object({
        windowSize: z.literal(10),
        mainAgent: CacheRateViewSchema,
        allPurposes: CacheRateViewSchema,
      })
      .strict(),
    latestRequest: z
      .object({
        purpose: PromptCacheRequestPurposeSchema,
        inputTokens: SafeTokenCountSchema.optional(),
        hitTokens: SafeTokenCountSchema.optional(),
        missTokens: SafeTokenCountSchema.optional(),
        writeTokens: SafeTokenCountSchema.optional(),
        cacheUsageReported: z.boolean(),
      })
      .strict()
      .superRefine((request, context) => {
        const reported = request.hitTokens !== undefined && request.missTokens !== undefined;
        if (request.cacheUsageReported !== reported) {
          context.addIssue({
            code: "custom",
            path: ["cacheUsageReported"],
            message: "Latest cache Usage completeness must match the reported hit and miss fields.",
          });
        }
      })
      .optional(),
    previousInputCoverage: z
      .object({
        classification: z.literal("DIAGNOSTIC_PROXY"),
        hitTokens: SafeTokenCountSchema,
        previousInputTokens: SafeTokenCountSchema,
        coverage: SafeRateSchema,
      })
      .strict()
      .superRefine((proxy, context) => {
        if (proxy.previousInputTokens === 0 || proxy.hitTokens > proxy.previousInputTokens) {
          context.addIssue({
            code: "custom",
            path: ["previousInputTokens"],
            message: "Previous-input coverage requires a positive prior input count.",
          });
        }
        if (proxy.coverage !== proxy.hitTokens / proxy.previousInputTokens) {
          context.addIssue({
            code: "custom",
            path: ["coverage"],
            message: "Diagnostic proxy coverage must match its bounded token counts.",
          });
        }
      })
      .optional(),
    usageCoverage: z
      .object({
        observedRequestCount: SafeTokenCountSchema,
        completeCacheUsageCount: SafeTokenCountSchema,
        incompleteOrUnknownCount: SafeTokenCountSchema,
        /** Usage facts below are diagnostic facets and may overlap. */
        providerUsageUnreportedCount: SafeTokenCountSchema,
        providerUsageWithoutCacheBreakdownCount: SafeTokenCountSchema,
        failedOrCancelledWithoutUsageCount: SafeTokenCountSchema,
        inProgressInvocationCount: SafeTokenCountSchema,
        missingInvocationRecordCount: SafeTokenCountSchema,
        legacyWithoutCacheBreakdownCount: SafeTokenCountSchema,
        unidentifiedLegacySampleCount: SafeTokenCountSchema,
        coverageRate: SafeRateSchema.optional(),
        status: z.enum(["REPORTED", "PARTIAL", "UNREPORTED"]),
      })
      .strict()
      .superRefine((coverage, context) => {
        const accounted = coverage.completeCacheUsageCount + coverage.incompleteOrUnknownCount;
        if (!Number.isSafeInteger(accounted) || accounted !== coverage.observedRequestCount) {
          context.addIssue({
            code: "custom",
            path: ["observedRequestCount"],
            message: "Usage coverage counts must account for every observed request exactly once.",
          });
        }
        if ((coverage.observedRequestCount === 0) !== (coverage.coverageRate === undefined)) {
          context.addIssue({
            code: "custom",
            path: ["coverageRate"],
            message: "Usage coverage rate is absent when there are no observed requests.",
          });
        }
        if (
          coverage.observedRequestCount > 0 &&
          coverage.coverageRate !== coverage.completeCacheUsageCount / coverage.observedRequestCount
        ) {
          context.addIssue({
            code: "custom",
            path: ["coverageRate"],
            message: "Usage coverage rate must match its request counts.",
          });
        }
        const expectedStatus =
          coverage.observedRequestCount === 0 || coverage.completeCacheUsageCount === 0
            ? "UNREPORTED"
            : coverage.completeCacheUsageCount === coverage.observedRequestCount
              ? "REPORTED"
              : "PARTIAL";
        if (coverage.status !== expectedStatus) {
          context.addIssue({
            code: "custom",
            path: ["status"],
            message: "Usage coverage status must match its request counts.",
          });
        }
        for (const field of [
          "providerUsageUnreportedCount",
          "providerUsageWithoutCacheBreakdownCount",
          "failedOrCancelledWithoutUsageCount",
          "inProgressInvocationCount",
          "missingInvocationRecordCount",
          "legacyWithoutCacheBreakdownCount",
        ] as const) {
          if (coverage[field] > coverage.observedRequestCount) {
            context.addIssue({
              code: "custom",
              path: [field],
              message: "Usage coverage diagnostic counts cannot exceed observed requests.",
            });
          }
        }
      }),
    surfaceDelta: z
      .object({
        availability: z.enum(["AVAILABLE", "NOT_AVAILABLE_FOR_V2"]),
        baselineCount: SafeTokenCountSchema.optional(),
        deltaCount: SafeTokenCountSchema.optional(),
        noopCount: SafeTokenCountSchema.optional(),
        setCount: SafeTokenCountSchema.optional(),
        clearCount: SafeTokenCountSchema.optional(),
        newModelVisibleBytes: SafeTokenCountSchema.optional(),
        estimatedNewContextTokens: SafeTokenCountSchema.optional(),
        unchangedSectionReemissionCount: SafeTokenCountSchema.optional(),
        tokenEstimateKind: z.literal("ESTIMATED").optional(),
      })
      .strict()
      .superRefine((surface, context) => {
        const availableFields = [
          "baselineCount",
          "deltaCount",
          "noopCount",
          "setCount",
          "clearCount",
          "newModelVisibleBytes",
          "estimatedNewContextTokens",
          "unchangedSectionReemissionCount",
          "tokenEstimateKind",
        ] as const;
        const presentCount = availableFields.filter((field) => surface[field] !== undefined).length;
        if (
          (surface.availability === "AVAILABLE" && presentCount !== availableFields.length) ||
          (surface.availability === "NOT_AVAILABLE_FOR_V2" && presentCount !== 0)
        ) {
          context.addIssue({
            code: "custom",
            path: ["availability"],
            message: "Prompt Surface diagnostics must be complete or explicitly unavailable.",
          });
        }
        if (
          surface.newModelVisibleBytes !== undefined &&
          surface.estimatedNewContextTokens !== Math.ceil(surface.newModelVisibleBytes / 3)
        ) {
          context.addIssue({
            code: "custom",
            path: ["estimatedNewContextTokens"],
            message:
              "Estimated context tokens must use the documented bytes-divided-by-three estimate.",
          });
        }
      }),
  })
  .strict();

export const PromptCachePurposeUsageSchema = z
  .object({
    purpose: PromptCacheRequestPurposeSchema,
    requestCount: SafeTokenCountSchema,
    inputTokens: SafeTokenCountSchema,
    outputTokens: SafeTokenCountSchema,
    hitTokens: SafeTokenCountSchema,
    missTokens: SafeTokenCountSchema,
    writeTokens: SafeTokenCountSchema,
    reasoningTokens: SafeTokenCountSchema.optional(),
    /** Per-field request coverage; absent on legacy persisted projections. */
    usageFieldCoverage: z
      .object({
        inputTokens: SafeTokenCountSchema,
        outputTokens: SafeTokenCountSchema,
        hitTokens: SafeTokenCountSchema,
        missTokens: SafeTokenCountSchema,
        writeTokens: SafeTokenCountSchema,
        reasoningTokens: SafeTokenCountSchema,
      })
      .strict()
      .optional(),
    unknownUsageCount: SafeTokenCountSchema,
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.unknownUsageCount > usage.requestCount) {
      context.addIssue({
        code: "custom",
        path: ["unknownUsageCount"],
        message: "Purpose unknown usage count cannot exceed its request count.",
      });
    }
    if (
      usage.usageFieldCoverage !== undefined &&
      Object.values(usage.usageFieldCoverage).some((count) => count > usage.requestCount)
    ) {
      context.addIssue({
        code: "custom",
        path: ["usageFieldCoverage"],
        message: "Reported usage request counts cannot exceed the purpose request count.",
      });
    }
  });

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
    purposes: z.array(PromptCachePurposeUsageSchema).max(8),
    surfaceSegments: PromptCacheSurfaceSegmentsSchema.optional(),
    /** Additive C4 projection. Missing means a legacy persisted projection. */
    metricsV2: CacheMetricsV2Schema.optional(),
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
export type CacheMetricsV2 = z.infer<typeof CacheMetricsV2Schema>;
export type PromptCacheUsage = z.infer<typeof PromptCacheUsageSchema>;
export type ContextUsageProjection = z.infer<typeof ContextUsageProjectionSchema>;
export type ContextUsageResponse = z.infer<typeof ContextUsageResponseSchema>;
