import { z } from "zod";
import { PlanItemIdSchema } from "./primitives/ids.js";

export const PlanStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanItemSchema = z
  .object({
    id: PlanItemIdSchema,
    title: z.string().min(1),
    detail: z.string().min(1).optional(),
    status: PlanStatusSchema,
  })
  .strict();
export type PlanItem = z.infer<typeof PlanItemSchema>;
