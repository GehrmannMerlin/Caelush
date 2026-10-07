import { z } from "zod";
import { AssistantMessagePhaseSchema } from "../api/transcript.js";
import { TimestampMsSchema } from "../primitives/time.js";
import {
  CoalescibleTransientEventMetaSchema,
  createVersionedEventSchema,
  OrderedTransientEventMetaSchema,
} from "./base.js";
import { ToolNameSchema } from "../tool.js";

/** A provider-approved public assistant text delta; never a full assistant message. */
export const ModelTextDeltaEventSchema = createVersionedEventSchema(
  "model.text.delta",
  1,
  z.object({ text: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

/** Phase-aware assistant-item delta. V1 remains registered for historical live-event replay. */
export const ModelTextDeltaEventV2Schema = createVersionedEventSchema(
  "model.text.delta",
  2,
  z
    .object({
      text: z.string(),
      assistantItemId: z.string().min(1).max(512),
      phase: AssistantMessagePhaseSchema,
    })
    .strict(),
  OrderedTransientEventMetaSchema,
);

/** A display-safe reasoning summary, never raw chain-of-thought or provider-private reasoning. */
export const ModelReasoningSummaryDeltaEventSchema = createVersionedEventSchema(
  "model.reasoning_summary.delta",
  1,
  z.object({ text: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

/** Legacy internal tool-call argument delta. The event catalog classifies it as DEBUG. */
export const ModelToolCallDeltaEventSchema = createVersionedEventSchema(
  "model.tool_call.delta",
  1,
  z.object({ toolCallId: z.string().min(1), delta: z.string() }).strict(),
  OrderedTransientEventMetaSchema,
);

/** Safe preparation metadata for one model Tool call; arguments never enter this event. */
export const ModelToolCallStartedEventSchema = createVersionedEventSchema(
  "model.tool_call.started",
  1,
  z.object({ toolCallId: z.string().min(1), toolName: ToolNameSchema }).strict(),
  OrderedTransientEventMetaSchema,
).superRefine((event, context) => {
  if (event.visibility !== "USER_VISIBLE") {
    context.addIssue({
      code: "custom",
      path: ["visibility"],
      message: "model Tool preparation must be USER_VISIBLE",
    });
  }
  if (
    event.stepId === undefined ||
    !("streamKey" in event.durability) ||
    event.durability.streamKey !==
      `model:tool-call:${event.runId}:${event.stepId}:${event.payload.toolCallId}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["durability", "streamKey"],
      message: "model Tool preparation stream key must match its call identity",
    });
  }
});

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
export type ModelTextDeltaEventV2 = z.infer<typeof ModelTextDeltaEventV2Schema>;
export type ModelReasoningSummaryDeltaEvent = z.infer<typeof ModelReasoningSummaryDeltaEventSchema>;
export type ModelToolCallDeltaEvent = z.infer<typeof ModelToolCallDeltaEventSchema>;
export type ModelToolCallStartedEvent = z.infer<typeof ModelToolCallStartedEventSchema>;
export type ModelStatusEvent = z.infer<typeof ModelStatusEventSchema>;
