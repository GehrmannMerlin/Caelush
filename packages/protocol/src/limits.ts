import { z } from "zod";

const positiveInteger = z.number().int().positive();
const safePositiveInteger = positiveInteger.refine(Number.isSafeInteger, "must be a safe integer");

export const RunLimitsSchema = z
  .object({
    maxSteps: positiveInteger,
    maxToolCalls: positiveInteger,
    timeoutMs: safePositiveInteger,
    maxTokens: positiveInteger.optional(),
    maxCost: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimitsSchema>;
