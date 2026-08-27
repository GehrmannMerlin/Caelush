import { z } from "zod";
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

export type VerificationStartedEvent = z.infer<typeof VerificationStartedEventSchema>;
export type VerificationCompletedEvent = z.infer<typeof VerificationCompletedEventSchema>;
