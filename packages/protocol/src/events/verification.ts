import { z } from "zod";
import {
  VerificationCheckIdSchema,
  VerificationPlanIdSchema,
  StepIdSchema,
} from "../primitives/ids.js";
import {
  VerificationCheckKindSchema,
  VerificationCheckPurposeSchema,
  VerificationCheckStageSchema,
  VerificationCheckTerminalStatusSchema,
  VerificationResultSchema,
} from "../verification.js";
import { createEventSchema } from "./base.js";

export const VerificationStartedEventSchema = createEventSchema(
  "verification.started",
  z.object({ type: z.string().min(1), command: z.string().min(1).optional() }).strict(),
);
export const VerificationCompletedEventSchema = createEventSchema(
  "verification.completed",
  z.object({ result: VerificationResultSchema }).strict(),
);

export const VerificationPlannedEventSchema = createEventSchema(
  "verification.planned",
  z
    .object({
      planId: VerificationPlanIdSchema,
      sourceStepId: StepIdSchema,
      checkCount: z.number().int().nonnegative().max(32),
      plannerVersion: z.string().min(1).max(128),
      counts: z
        .object({
          required: z.number().int().nonnegative().max(32),
          ifAvailable: z.number().int().nonnegative().max(32),
          advisory: z.number().int().nonnegative().max(32),
        })
        .strict(),
    })
    .strict(),
);

export const VerificationCheckStartedEventSchema = createEventSchema(
  "verification.check.started",
  z
    .object({
      planId: VerificationPlanIdSchema,
      checkId: VerificationCheckIdSchema,
      ordinal: z.number().int().min(0).max(31),
      kind: VerificationCheckKindSchema,
      purpose: VerificationCheckPurposeSchema,
      stage: VerificationCheckStageSchema,
    })
    .strict(),
);

export const VerificationCheckCompletedEventSchema = createEventSchema(
  "verification.check.completed",
  z
    .object({
      planId: VerificationPlanIdSchema,
      checkId: VerificationCheckIdSchema,
      status: VerificationCheckTerminalStatusSchema,
      evidenceIds: z.array(z.string().min(1)).max(64),
      durationMs: z.number().int().nonnegative().refine(Number.isSafeInteger).optional(),
    })
    .strict(),
);

export type VerificationStartedEvent = z.infer<typeof VerificationStartedEventSchema>;
export type VerificationCompletedEvent = z.infer<typeof VerificationCompletedEventSchema>;
export type VerificationPlannedEvent = z.infer<typeof VerificationPlannedEventSchema>;
export type VerificationCheckStartedEvent = z.infer<typeof VerificationCheckStartedEventSchema>;
export type VerificationCheckCompletedEvent = z.infer<typeof VerificationCheckCompletedEventSchema>;

export const VerificationRepairStartedEventSchema = createEventSchema(
  "verification.repair.started",
  z
    .object({
      failedPlanId: VerificationPlanIdSchema,
      failedCheckIds: z.array(VerificationCheckIdSchema).min(1).max(32),
      repairCycle: z.number().int().nonnegative().max(10),
    })
    .strict(),
);

export const VerificationRepairLimitReachedEventSchema = createEventSchema(
  "verification.repair.limit_reached",
  z
    .object({
      planId: VerificationPlanIdSchema,
      attemptedRepairs: z.number().int().nonnegative().max(10),
      maxAutoRepairs: z.number().int().nonnegative().max(10),
    })
    .strict(),
);

export const VerificationFinalizedEventSchema = createEventSchema(
  "verification.finalized",
  z
    .object({
      planId: VerificationPlanIdSchema,
      outcome: z.enum(["PASSED", "FAILED", "ERROR"]),
      sealHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      failedCheckIds: z.array(VerificationCheckIdSchema).max(32),
      errorCheckIds: z.array(VerificationCheckIdSchema).max(32),
    })
    .strict(),
);

export type VerificationRepairStartedEvent = z.infer<typeof VerificationRepairStartedEventSchema>;
export type VerificationRepairLimitReachedEvent = z.infer<
  typeof VerificationRepairLimitReachedEventSchema
>;
export type VerificationFinalizedEvent = z.infer<typeof VerificationFinalizedEventSchema>;
