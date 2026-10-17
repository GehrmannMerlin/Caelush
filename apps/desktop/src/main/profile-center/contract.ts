import { z } from "zod";
import {
  AIModelDirectoryResponseSchema,
  AIProvidersResponseSchema,
  SessionIdSchema,
  TimestampMsSchema,
  UsageActivityDaySchema,
  UsageActivityQuerySchema,
  UsageSummaryResponseSchema,
} from "@caelush/protocol";

export const AccountCenterQuerySchema = UsageActivityQuerySchema;
export type AccountCenterQuery = {
  readonly sinceMs: number;
  readonly timezoneOffsetMinutes?: number;
};

export const DesktopModelSettingsSnapshotSchema = z
  .object({
    providers: AIProvidersResponseSchema.shape.providers,
    models: AIModelDirectoryResponseSchema.shape.models,
  })
  .strict();

export const DesktopProviderSettingsConnectInputSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();

export const DesktopProviderSettingsDisconnectInputSchema = z
  .object({ providerId: z.string().min(1).max(128) })
  .strict();

export const DesktopProviderSettingsConnectionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), message: z.string().min(1).max(256) }).strict(),
]);

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
    activity: z.array(UsageActivityDaySchema).max(366).optional(),
  })
  .strict();

export type AccountCenterSession = z.infer<typeof AccountCenterSessionSchema>;
export type AccountCenterSnapshot = z.infer<typeof AccountCenterSnapshotSchema>;
export type DesktopModelSettingsSnapshot = z.infer<typeof DesktopModelSettingsSnapshotSchema>;
export type DesktopProviderSettingsConnectionResult = z.infer<
  typeof DesktopProviderSettingsConnectionResultSchema
>;
export type DesktopProviderSettingsConnectInput = z.infer<
  typeof DesktopProviderSettingsConnectInputSchema
>;
export type DesktopProviderSettingsDisconnectInput = z.infer<
  typeof DesktopProviderSettingsDisconnectInputSchema
>;
