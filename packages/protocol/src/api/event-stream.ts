import { z } from "zod";

export const EventStreamQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type EventStreamQuery = z.infer<typeof EventStreamQuerySchema>;
