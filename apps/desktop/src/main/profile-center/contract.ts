import { z } from "zod";
import { SessionIdSchema, TimestampMsSchema, UsageSummaryResponseSchema } from "@caelush/protocol";

export const AccountCenterSessionSchema = z
  .object({
    id: SessionIdSchema,
    title: z.string().min(1).max(96),
    updatedAt: TimestampMsSchema,
  })
  .strict();

export const AccountCenterSnapshotSchema = z
  .object({
    recentSessions: z.array(AccountCenterSessionSchema).max(3),
    usage: UsageSummaryResponseSchema,
  })
  .strict();

export type AccountCenterSession = z.infer<typeof AccountCenterSessionSchema>;
export type AccountCenterSnapshot = z.infer<typeof AccountCenterSnapshotSchema>;
