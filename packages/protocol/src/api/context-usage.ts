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
  })
  .strict();

export const ContextUsageResponseSchema = ContextUsageProjectionSchema.nullable();
export type ContextUsageProjection = z.infer<typeof ContextUsageProjectionSchema>;
export type ContextUsageResponse = z.infer<typeof ContextUsageResponseSchema>;
