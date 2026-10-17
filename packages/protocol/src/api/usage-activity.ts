import { z } from "zod";

const usageCount = z.number().int().nonnegative().safe();

export const UsageActivityQuerySchema = z
  .object({
    sinceMs: z.coerce.number().int().nonnegative().safe(),
    timezoneOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .strict();
export type UsageActivityQuery = z.infer<typeof UsageActivityQuerySchema>;

export const UsageActivityDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    successfulRequests: usageCount,
    totalTokens: usageCount.nullable(),
  })
  .strict();
export type UsageActivityDay = z.infer<typeof UsageActivityDaySchema>;

export const UsageActivityResponseSchema = z
  .object({
    days: z.array(UsageActivityDaySchema).max(366),
  })
  .strict();
export type UsageActivityResponse = z.infer<typeof UsageActivityResponseSchema>;
