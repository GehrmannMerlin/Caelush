import { z } from "zod";
import { createVersionedEventSchema, OrderedTransientEventMetaSchema } from "./base.js";

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

export type ModelTextDeltaEvent = z.infer<typeof ModelTextDeltaEventSchema>;
export type ModelReasoningSummaryDeltaEvent = z.infer<typeof ModelReasoningSummaryDeltaEventSchema>;
export type ModelToolCallDeltaEvent = z.infer<typeof ModelToolCallDeltaEventSchema>;
