import { z } from "zod";
import { RunIdSchema, SessionIdSchema, StepIdSchema, EventIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";

export const EventVisibilitySchema = z.enum(["USER_VISIBLE", "DEBUG", "SYSTEM"]);
export type EventVisibility = z.infer<typeof EventVisibilitySchema>;

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "expected a positive safe integer");

/** A schema version is extensible, but never zero, fractional, or unsafe. */
export const EventSchemaVersionSchema = PositiveSafeIntegerSchema;
export type EventSchemaVersion = z.infer<typeof EventSchemaVersionSchema>;

export const DurableEventSchema = z
  .object({
    kind: z.literal("DURABLE"),
    version: z.literal(1),
    sequence: PositiveSafeIntegerSchema,
  })
  .strict();
export type DurableEvent = z.infer<typeof DurableEventSchema>;

/** The committed V2 durable metadata shape. Storage is the only sequence authority. */
export const DurableRunEventMetaSchema = DurableEventSchema;
export type DurableRunEventMeta = z.infer<typeof DurableRunEventMetaSchema>;

export const TransientDeliveryClassSchema = z.enum(["ORDERED", "COALESCIBLE"]);
export type TransientDeliveryClass = z.infer<typeof TransientDeliveryClassSchema>;

export const OrderedTransientEventMetaSchema = z
  .object({
    kind: z.literal("EPHEMERAL"),
    version: z.literal(1),
    deliveryClass: z.literal("ORDERED"),
    streamKey: z.string().min(1),
    streamSequence: PositiveSafeIntegerSchema,
  })
  .strict();
export type OrderedTransientEventMeta = z.infer<typeof OrderedTransientEventMetaSchema>;

export const CoalescibleTransientEventMetaSchema = z
  .object({
    kind: z.literal("EPHEMERAL"),
    version: z.literal(1),
    deliveryClass: z.literal("COALESCIBLE"),
    streamKey: z.string().min(1),
  })
  .strict();
export type CoalescibleTransientEventMeta = z.infer<typeof CoalescibleTransientEventMetaSchema>;

export const TransientRunEventMetaSchema = z.union([
  OrderedTransientEventMetaSchema,
  CoalescibleTransientEventMetaSchema,
]);
export type TransientRunEventMeta = z.infer<typeof TransientRunEventMetaSchema>;

/** Canonical V2 metadata; unlike the compatibility schema below, EPHEMERAL is never empty. */
export const RunEventDurabilitySchema = z.union([
  DurableRunEventMetaSchema,
  TransientRunEventMetaSchema,
]);
export type RunEventDurability = z.infer<typeof RunEventDurabilitySchema>;

/**
 * The old wire shape remains readable during the staged migration. It is intentionally not part
 * of `RunEventDurabilitySchema`: a v1 compatibility event may have an empty EPHEMERAL metadata
 * object, while new V2 transient contracts must carry delivery metadata.
 */
export const EphemeralEventSchema = z
  .object({
    kind: z.literal("EPHEMERAL"),
  })
  .strict();
export type EphemeralEvent = z.infer<typeof EphemeralEventSchema>;

export const EventDurabilitySchema = z.union([
  DurableEventSchema,
  EphemeralEventSchema,
  OrderedTransientEventMetaSchema,
  CoalescibleTransientEventMetaSchema,
]);
export type EventDurability = z.infer<typeof EventDurabilitySchema>;

export interface RunEventBase<TDurability extends DurableRunEventMeta | TransientRunEventMeta> {
  readonly eventId: import("../primitives/ids.js").EventId;
  readonly schemaVersion: EventSchemaVersion;
  readonly runId: import("../primitives/ids.js").RunId;
  readonly sessionId: import("../primitives/ids.js").SessionId;
  readonly stepId?: import("../primitives/ids.js").StepId;
  readonly timestamp: import("../primitives/time.js").TimestampMs;
  readonly visibility: EventVisibility;
  readonly durability: TDurability;
}

const eventBaseShape = (
  schemaVersion: EventSchemaVersion,
  durability: z.ZodType<EventDurability>,
) => ({
  eventId: EventIdSchema,
  schemaVersion: z.literal(schemaVersion),
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  stepId: StepIdSchema.optional(),
  timestamp: TimestampMsSchema,
  visibility: EventVisibilitySchema,
  durability,
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
});

/**
 * Creates a versioned event schema without changing the compatibility-shaped v1 factory.
 *
 * A type may intentionally have more than one registered version: for example, historical
 * `tool.output@1` is durable while current `tool.output@2` is transient. The version and
 * durability metadata are therefore explicit inputs rather than inferred from the event type.
 */
export function createVersionedEventSchema<
  const EventType extends string,
  const SchemaVersion extends EventSchemaVersion,
  PayloadSchema extends z.ZodType,
  DurabilitySchema extends z.ZodType<EventDurability> = typeof EventDurabilitySchema,
>(
  type: EventType,
  schemaVersion: SchemaVersion,
  payload: PayloadSchema,
  durability: DurabilitySchema = EventDurabilitySchema as unknown as DurabilitySchema,
) {
  return z
    .object({
      ...eventBaseShape(schemaVersion, durability),
      type: z.literal(type),
      payload,
    })
    .strict();
}

export function createEventSchema<const EventType extends string, PayloadSchema extends z.ZodType>(
  type: EventType,
  payload: PayloadSchema,
) {
  return createVersionedEventSchema(type, 1, payload);
}
