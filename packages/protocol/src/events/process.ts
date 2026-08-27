import { z } from "zod";
import { ProcessStatusSchema, ProcessSummarySchema } from "../process.js";
import { createEventSchema } from "./base.js";

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
export const ProcessStoppedEventSchema = createEventSchema(
  "process.stopped",
  z.object({ processId: z.string().min(1), status: ProcessStatusSchema }).strict(),
);

export type ProcessStartedEvent = z.infer<typeof ProcessStartedEventSchema>;
export type ProcessOutputEvent = z.infer<typeof ProcessOutputEventSchema>;
export type ProcessStoppedEvent = z.infer<typeof ProcessStoppedEventSchema>;
