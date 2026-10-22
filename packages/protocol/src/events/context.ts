import { z } from "zod";

import {
  CoalescibleTransientEventMetaSchema,
  createEventSchema,
  createVersionedEventSchema,
} from "./base.js";

const ContextCompactionReasonSchema = z.enum([
  "PROACTIVE_PRESSURE",
  "SELECTION_PRESSURE",
  "FORCED_PROVIDER_OVERFLOW",
]);

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
      reason: ContextCompactionReasonSchema,
      sourceSequenceFrom: z.number().int().nonnegative().refine(Number.isSafeInteger),
      sourceSequenceTo: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensBefore: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensAfter: z.number().int().nonnegative().refine(Number.isSafeInteger),
      degraded: z.boolean(),
    })
    .strict(),
);

export type ContextCompactionCompletedEvent = z.infer<typeof ContextCompactionCompletedEventSchema>;

/** A live-only, bounded stage signal; checkpoint completion remains the durable compaction fact. */
export const ContextCompactionProgressEventSchema = createVersionedEventSchema(
  "context.compaction.progress",
  1,
  z
    .object({
      stage: z.enum(["PREPARING", "SUMMARIZING", "REBUILDING", "FINISHED"]),
      reason: ContextCompactionReasonSchema,
    })
    .strict(),
  CoalescibleTransientEventMetaSchema,
).superRefine((event, context) => {
  if (event.visibility !== "USER_VISIBLE") {
    context.addIssue({
      code: "custom",
      path: ["visibility"],
      message: "context compaction progress must be USER_VISIBLE",
    });
  }
  if (
    event.stepId === undefined ||
    !("streamKey" in event.durability) ||
    event.durability.streamKey !== `context:compaction:${event.runId}:${event.stepId}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["durability", "streamKey"],
      message: "context compaction progress stream key must match its run and step",
    });
  }
});

export type ContextCompactionProgressEvent = z.infer<typeof ContextCompactionProgressEventSchema>;
