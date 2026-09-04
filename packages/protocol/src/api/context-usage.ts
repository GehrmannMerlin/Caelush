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
  })
  .strict();

export const ContextUsagePressureStateSchema = z.enum(["NORMAL", "PROACTIVE", "EMERGENCY"]);

export const ContextUsageProjectionSchema = z
  .object({
    runId: RunIdSchema,
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative(),
    effectiveInputLimitTokens: z.number().int().positive(),
    estimatedInputTokens: z.number().int().nonnegative(),
    usedRatio: z.number().min(0).max(1),
    remainingTokens: z.number().int().nonnegative(),
    pressureState: ContextUsagePressureStateSchema,
    compactionCount: z.number().int().nonnegative(),
    lastCompactionAt: TimestampMsSchema.optional(),
    breakdown: ContextUsageBreakdownSchema,
    updatedAt: TimestampMsSchema,
  })
  .strict();

export const ContextUsageResponseSchema = ContextUsageProjectionSchema.nullable();
export type ContextUsageProjection = z.infer<typeof ContextUsageProjectionSchema>;
export type ContextUsageResponse = z.infer<typeof ContextUsageResponseSchema>;
