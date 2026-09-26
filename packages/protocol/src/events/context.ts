import { z } from "zod";

import { createEventSchema } from "./base.js";

/**
 * A durable fact that a V2 Context checkpoint and its covered conversation range committed.
 *
 * The checkpoint remains the Context authority. This event is deliberately metadata-only so the
 * event stream never becomes a second summary, prompt, or conversation store.
 */
export const ContextCompactionCompletedEventSchema = createEventSchema(
  "context.compaction.completed",
  z
    .object({
      checkpointId: z.string().min(1),
      reason: z.enum(["PROACTIVE_PRESSURE", "SELECTION_PRESSURE", "FORCED_PROVIDER_OVERFLOW"]),
      sourceSequenceFrom: z.number().int().nonnegative().refine(Number.isSafeInteger),
      sourceSequenceTo: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensBefore: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensAfter: z.number().int().nonnegative().refine(Number.isSafeInteger),
      degraded: z.boolean(),
    })
    .strict(),
);

export type ContextCompactionCompletedEvent = z.infer<typeof ContextCompactionCompletedEventSchema>;
