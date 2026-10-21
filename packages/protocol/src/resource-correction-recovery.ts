import { z } from "zod";
import { RunIdSchema, StepIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

/** Auditable authorization to upgrade a historical ordinary resource wait to autonomous correction. */
export const RunCorrectionRecoveryRecordV1Schema = z
  .object({
    version: z.literal(1),
    runId: RunIdSchema,
    decisionId: z.string().regex(/^[a-f0-9]{64}$/),
    sourceStepId: StepIdSchema.optional(),
    stateRevision: z.number().int().nonnegative(),
    continuationRevision: z.number().int().nonnegative(),
    reason: z.literal("LEGACY_NO_PROGRESS"),
    fromCorrectionVersion: z.literal("HISTORICAL_V1"),
    effectiveCorrectionVersion: z.literal("AUTONOMOUS_CORRECTION_V2"),
    authority: z.literal("DAEMON_AUTO_CORRECTION_V1"),
    committedAt: TimestampMsSchema,
  })
  .strict();

export type RunCorrectionRecoveryRecordV1 = z.infer<typeof RunCorrectionRecoveryRecordV1Schema>;

export function parseRunCorrectionRecoveryRecordV1(value: unknown): RunCorrectionRecoveryRecordV1 {
  return RunCorrectionRecoveryRecordV1Schema.parse(value);
}
