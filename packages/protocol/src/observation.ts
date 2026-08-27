import { z } from "zod";
import { JsonObjectSchema } from "./primitives/json.js";
import {
  ObservationIdSchema,
  RunIdSchema,
  StepIdSchema,
  ToolInvocationIdSchema,
  VerificationResultIdSchema,
} from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

const observationBase = {
  id: ObservationIdSchema,
  runId: RunIdSchema,
  stepId: StepIdSchema,
  content: z.string(),
  details: JsonObjectSchema.optional(),
  isError: z.boolean(),
  createdAt: TimestampMsSchema,
};

export const ToolObservationSchema = z
  .object({
    ...observationBase,
    kind: z.literal("TOOL"),
    toolInvocationId: ToolInvocationIdSchema,
  })
  .strict();
export type ToolObservation = z.infer<typeof ToolObservationSchema>;

export const VerificationObservationSchema = z
  .object({
    ...observationBase,
    kind: z.literal("VERIFICATION"),
    verificationResultId: VerificationResultIdSchema,
  })
  .strict();
export type VerificationObservation = z.infer<typeof VerificationObservationSchema>;

export const SystemObservationSchema = z
  .object({
    ...observationBase,
    kind: z.literal("SYSTEM"),
  })
  .strict();
export type SystemObservation = z.infer<typeof SystemObservationSchema>;

export const ObservationSchema = z.discriminatedUnion("kind", [
  ToolObservationSchema,
  VerificationObservationSchema,
  SystemObservationSchema,
]);
export type Observation = z.infer<typeof ObservationSchema>;
