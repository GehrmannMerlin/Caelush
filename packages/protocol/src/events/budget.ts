import { z } from "zod";
import { createEventSchema } from "./base.js";

const budgetExceededPayload = z.discriminatedUnion("dimension", [
  z
    .object({
      dimension: z.literal("TOOL_CALLS"),
      limit: z.number().int().nonnegative().safe(),
      accounted: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      dimension: z.literal("TOKENS"),
      limit: z.number().int().nonnegative().safe(),
      accounted: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      dimension: z.literal("COST"),
      limitMicros: z.number().int().nonnegative().safe(),
      accountedMicros: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);

export const BudgetExceededEventSchema = createEventSchema(
  "budget.exceeded",
  budgetExceededPayload,
);
export type BudgetExceededEvent = z.infer<typeof BudgetExceededEventSchema>;
