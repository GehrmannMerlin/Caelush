import { z } from "zod";
import { ProcessStatusSchema, ProcessSummarySchema } from "../process.js";
import {
  createEventSchema,
  createVersionedEventSchema,
  OrderedTransientEventMetaSchema,
} from "./base.js";

const outputStreamSchema = z.enum(["stdout", "stderr"]);

export const ProcessStartedEventSchema = createEventSchema(
  "process.started",
  z.object({ process: ProcessSummarySchema }).strict(),
);
export const ProcessOutputEventSchema = createEventSchema(
  "process.output",
  z
    .object({ processId: z.string().min(1), stream: outputStreamSchema, chunk: z.string() })
    .strict(),
);
/** Current live process output. Historical durable output remains `ProcessOutputEventSchema` v1. */
export const ProcessOutputEventV2Schema = createVersionedEventSchema(
  "process.output",
  2,
  z
    .object({ processId: z.string().min(1), stream: outputStreamSchema, chunk: z.string() })
    .strict(),
  OrderedTransientEventMetaSchema,
);
export const ProcessOutputTransientEventSchema = ProcessOutputEventV2Schema;
export const ProcessStoppedEventSchema = createEventSchema(
  "process.stopped",
  z.object({ processId: z.string().min(1), status: ProcessStatusSchema }).strict(),
);

export type ProcessStartedEvent = z.infer<typeof ProcessStartedEventSchema>;
export type ProcessOutputEvent = z.infer<typeof ProcessOutputEventSchema>;
export type ProcessOutputEventV2 = z.infer<typeof ProcessOutputEventV2Schema>;
export type ProcessStoppedEvent = z.infer<typeof ProcessStoppedEventSchema>;
