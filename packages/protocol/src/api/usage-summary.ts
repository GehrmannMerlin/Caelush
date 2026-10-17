import { z } from "zod";

const count = z.number().int().nonnegative().safe();

export const UsageSummaryQuerySchema = z
  .object({
    sinceMs: z.coerce.number().int().nonnegative().safe(),
  })
  .strict();
export type UsageSummaryQuery = z.infer<typeof UsageSummaryQuerySchema>;

export const UsageSummaryBucketSchema = z
  .object({
    successfulRequests: count,
    totalTokens: count.nullable(),
  })
  .strict();
export type UsageSummaryBucket = z.infer<typeof UsageSummaryBucketSchema>;

export const UsageSummaryResponseSchema = z
  .object({
    allTime: UsageSummaryBucketSchema,
    since: UsageSummaryBucketSchema,
  })
  .strict();
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;
