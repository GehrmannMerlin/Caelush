import { z } from "zod";

export const EventStreamQuerySchema = z
  .object({
    afterSequence: z.coerce
      .number()
      .refine(Number.isSafeInteger, "afterSequence must be a safe integer")
      .nonnegative()
      .optional(),
  })
  .strict();
export type EventStreamQuery = z.infer<typeof EventStreamQuerySchema>;
