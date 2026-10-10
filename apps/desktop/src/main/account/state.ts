import { z } from "zod";
import { AccountEntitlementSchema, DeviceViewSchema } from "../cloud/schemas.js";

export const AccountStatusSchema = z.enum([
  "INITIALIZING",
  "LOGIN_REQUIRED",
  "REGISTERING",
  "VERIFYING_EMAIL",
  "AUTHENTICATING",
  "AUTHENTICATED_ONLINE",
  "AUTHORIZED_OFFLINE",
  "REFRESHING",
  "SESSION_EXPIRED",
  "OFFLINE_GRANT_EXPIRED",
  "DEVICE_REVOKED",
  "LOCKED",
  "ERROR",
]);

export const SafeAccountSchema = z
  .object({
    userId: z.uuid(),
    email: z.email().max(320),
    emailVerified: z.boolean(),
    entitlements: z.array(AccountEntitlementSchema).max(128),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const SafeDeviceSchema = DeviceViewSchema;
export const SafeDeviceListItemSchema = DeviceViewSchema;

export const AccountStateSchema = z
  .object({
    status: AccountStatusSchema,
    account: SafeAccountSchema.optional(),
    device: SafeDeviceSchema.optional(),
    devices: z.array(SafeDeviceListItemSchema).max(100).optional(),
    offlineGrant: z
      .object({
        issuedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
        entitlements: z.array(z.string().max(64)).max(128),
        remainingHours: z.number().int().nonnegative().max(360),
      })
      .strict()
      .nullable()
      .optional(),
    lastError: z
      .object({ code: z.string().max(64), message: z.string().min(1).max(512) })
      .strict()
      .nullable(),
    notice: z.string().max(512).nullable(),
    agentEntry: z
      .object({ available: z.literal(false), reason: z.literal("LOCAL_AGENT_INTEGRATION_PENDING") })
      .strict(),
  })
  .strict();

export type AccountStatus = z.infer<typeof AccountStatusSchema>;
export type SafeAccount = z.infer<typeof SafeAccountSchema>;
export type SafeDevice = z.infer<typeof SafeDeviceSchema>;
export type AccountState = z.infer<typeof AccountStateSchema>;

export function createInitialAccountState(status: AccountStatus = "INITIALIZING"): AccountState {
  return {
    status,
    lastError: null,
    notice: null,
    agentEntry: { available: false, reason: "LOCAL_AGENT_INTEGRATION_PENDING" },
  };
}
