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

/** Durable V3 compaction activation metadata. Detailed coverage remains in checkpoint storage. */
export const ContextCompactionCompletedEventV2Schema = createVersionedEventSchema(
  "context.compaction.completed",
  2,
  z
    .object({
      checkpointId: z.string().min(1),
      operationId: z.string().min(1),
      epochId: z.string().min(1),
      reason: ContextCompactionReasonSchema,
      sourceRangeCount: z.number().int().positive().refine(Number.isSafeInteger),
      sourceMessageCount: z.number().int().positive().refine(Number.isSafeInteger),
      tokensBefore: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensAfter: z.number().int().nonnegative().refine(Number.isSafeInteger),
      freedTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
      degraded: z.boolean(),
      targetStatus: z.enum(["DEEP", "FLOOR_LIMITED"]),
    })
    .strict(),
);

export type ContextCompactionCompletedEventV2 = z.infer<
  typeof ContextCompactionCompletedEventV2Schema
>;

/** Durable completion facts for elastic retention, added without changing V1/V2 decoders. */
export const ContextCompactionCompletedEventV3Schema = createVersionedEventSchema(
  "context.compaction.completed",
  3,
  z
    .object({
      checkpointId: z.string().min(1),
      operationId: z.string().min(1),
      epochId: z.string().min(1),
      reason: ContextCompactionReasonSchema,
      sourceRangeCount: z.number().int().positive().refine(Number.isSafeInteger),
      sourceMessageCount: z.number().int().positive().refine(Number.isSafeInteger),
      tokensBefore: z.number().int().nonnegative().refine(Number.isSafeInteger),
      tokensAfter: z.number().int().nonnegative().refine(Number.isSafeInteger),
      freedTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
      degraded: z.boolean(),
      targetStatus: z.enum(["PREFERRED", "ELASTIC", "FLOOR_LIMITED"]),
      retention: z
        .object({
          status: z.enum(["PREFERRED", "ELASTIC", "FLOOR_LIMITED"]),
          preferredInputTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
          protectedFloorInputTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
          hardInputLimitTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
          compressibleTokens: z.number().int().positive().refine(Number.isSafeInteger),
          minimumReleaseRatio: z.number().finite().gt(0).lt(1),
          minimumReleaseTokens: z.number().int().positive().refine(Number.isSafeInteger),
          actualFreedTokens: z.number().int().positive().refine(Number.isSafeInteger),
        })
        .strict(),
    })
    .strict(),
);

export type ContextCompactionCompletedEventV3 = z.infer<
  typeof ContextCompactionCompletedEventV3Schema
>;

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
