import { z } from "zod";
import { RunIdSchema, StepIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const StepStatusSchema = z.enum(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const AgentStepSchema = z
  .object({
    id: StepIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().positive(),
    status: StepStatusSchema,
    reasoningSummary: z.string().min(1).optional(),
    startedAt: TimestampMsSchema,
    finishedAt: TimestampMsSchema.optional(),
  })
  .strict();
export type AgentStep = z.infer<typeof AgentStepSchema>;
