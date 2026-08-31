import { z } from "zod";
import { VerificationPlanIdSchema, StepIdSchema } from "../primitives/ids.js";
import { VerificationResultSchema } from "../verification.js";
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

export type VerificationStartedEvent = z.infer<typeof VerificationStartedEventSchema>;
export type VerificationCompletedEvent = z.infer<typeof VerificationCompletedEventSchema>;
export type VerificationPlannedEvent = z.infer<typeof VerificationPlannedEventSchema>;
