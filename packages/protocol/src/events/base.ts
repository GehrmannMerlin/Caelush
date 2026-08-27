import { z } from "zod";
import { RunIdSchema, SessionIdSchema, StepIdSchema, EventIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";

export const EventVisibilitySchema = z.enum(["USER_VISIBLE", "DEBUG", "SYSTEM"]);
export type EventVisibility = z.infer<typeof EventVisibilitySchema>;

export const DurableEventSchema = z
  .object({
    kind: z.literal("DURABLE"),
    version: z.literal(1),
    sequence: z.number().int().positive(),
  })
  .strict();
export type DurableEvent = z.infer<typeof DurableEventSchema>;

export const EphemeralEventSchema = z
  .object({
    kind: z.literal("EPHEMERAL"),
  })
  .strict();
export type EphemeralEvent = z.infer<typeof EphemeralEventSchema>;

export const EventDurabilitySchema = z.discriminatedUnion("kind", [
  DurableEventSchema,
  EphemeralEventSchema,
]);
export type EventDurability = z.infer<typeof EventDurabilitySchema>;

const eventBaseShape = {
  eventId: EventIdSchema,
  schemaVersion: z.literal(1),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  stepId: StepIdSchema.optional(),
  timestamp: TimestampMsSchema,
  visibility: EventVisibilitySchema,
  durability: EventDurabilitySchema,
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
};

export function createEventSchema<const EventType extends string, PayloadSchema extends z.ZodType>(
  type: EventType,
  payload: PayloadSchema,
) {
  return z
    .object({
      ...eventBaseShape,
      type: z.literal(type),
      payload,
    })
    .strict();
}
