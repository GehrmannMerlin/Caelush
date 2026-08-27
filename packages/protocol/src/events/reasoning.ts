import { z } from "zod";
import { PlanItemSchema } from "../plan.js";
import { createEventSchema } from "./base.js";

export const ReasoningSummaryEventSchema = createEventSchema(
  "reasoning.summary",
  z.object({ summary: z.string().min(1) }).strict(),
);
export const PlanUpdatedEventSchema = createEventSchema(
  "plan.updated",
  z.object({ plan: z.array(PlanItemSchema) }).strict(),
);

export type ReasoningSummaryEvent = z.infer<typeof ReasoningSummaryEventSchema>;
export type PlanUpdatedEvent = z.infer<typeof PlanUpdatedEventSchema>;
