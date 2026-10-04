import { z } from "zod";
import { TimestampMsSchema } from "../primitives/time.js";
import {
  CoalescibleTransientEventMetaSchema,
  createVersionedEventSchema,
  OrderedTransientEventMetaSchema,
} from "./base.js";

/** A provider-approved public assistant text delta; never a full assistant message. */
export const ModelTextDeltaEventSchema = createVersionedEventSchema(
  "model.text.delta",
  1,
  z.object({ text: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

/** A display-safe reasoning summary, never raw chain-of-thought or provider-private reasoning. */
export const ModelReasoningSummaryDeltaEventSchema = createVersionedEventSchema(
  "model.reasoning_summary.delta",
  1,
  z.object({ text: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

/** Partial tool-call argument text; it is display-only and is not executable input. */
export const ModelToolCallDeltaEventSchema = createVersionedEventSchema(
  "model.tool_call.delta",
  1,
  z.object({ toolCallId: z.string().min(1), delta: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

const ModelStatusPhaseSchema = z.enum([
  "WAITING_PROVIDER",
  "RECEIVING_PROVIDER_DATA",
  "NO_RECENT_ACTIVITY",
  "CANCELLING_IDLE_STREAM",
]);

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "expected a nonnegative safe integer");

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "expected a positive safe integer");

/** Provider wait state is a bounded presentation signal, never model text or an error payload. */
export const ModelStatusEventSchema = createVersionedEventSchema(
  "model.status",
  1,
  z
    .object({
      phase: ModelStatusPhaseSchema,
      lastActivityAt: TimestampMsSchema,
      idleForMs: SafeNonnegativeIntegerSchema,
      idleTimeoutMs: PositiveSafeIntegerSchema,
    })
    .strict(),
  CoalescibleTransientEventMetaSchema,
).superRefine((event, context) => {
  if (event.visibility !== "USER_VISIBLE") {
    context.addIssue({
      code: "custom",
      path: ["visibility"],
      message: "model status must be USER_VISIBLE",
    });
  }
  if (
    event.stepId === undefined ||
    !("streamKey" in event.durability) ||
    event.durability.streamKey !== `model:status:${event.runId}:${event.stepId}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["durability", "streamKey"],
      message: "model status stream key must match its run and step",
    });
  }
});

export type ModelTextDeltaEvent = z.infer<typeof ModelTextDeltaEventSchema>;
export type ModelReasoningSummaryDeltaEvent = z.infer<typeof ModelReasoningSummaryDeltaEventSchema>;
export type ModelToolCallDeltaEvent = z.infer<typeof ModelToolCallDeltaEventSchema>;
export type ModelStatusEvent = z.infer<typeof ModelStatusEventSchema>;
