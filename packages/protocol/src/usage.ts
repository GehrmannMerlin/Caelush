import { z } from "zod";

export const UsageStateSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type UsageState = z.infer<typeof UsageStateSchema>;
