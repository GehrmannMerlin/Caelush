import { z } from "zod";
import { createEventSchema } from "./base.js";

/**
 * Durable, metadata-only facts about one accepted Run input.
 *
 * They carry identifiers and the Run-local intake sequence, never the user's text: the canonical
 * message is the only conversation authority, and an event must not become a second copy of it.
 */
export const RunInputAcceptedEventSchema = createEventSchema(
  "run.input.accepted",
  z
    .object({
      inputId: z.string().min(1),
      acceptedSequence: z.number().int().positive(),
    })
    .strict(),
);

export const RunInputAssignedEventSchema = createEventSchema(
  "run.input.assigned",
  z
    .object({
      inputId: z.string().min(1),
      acceptedSequence: z.number().int().positive(),
      messageId: z.string().min(1),
      stepId: z.string().min(1),
    })
    .strict(),
);

export type RunInputAcceptedEvent = z.infer<typeof RunInputAcceptedEventSchema>;
export type RunInputAssignedEvent = z.infer<typeof RunInputAssignedEventSchema>;
