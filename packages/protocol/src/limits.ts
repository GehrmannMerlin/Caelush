import { z } from "zod";

const positiveInteger = z.number().int().positive();

export const RunLimitsSchema = z
  .object({
    maxSteps: positiveInteger,
    maxToolCalls: positiveInteger,
    timeoutMs: positiveInteger,
    maxTokens: positiveInteger.optional(),
    maxCost: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimitsSchema>;
