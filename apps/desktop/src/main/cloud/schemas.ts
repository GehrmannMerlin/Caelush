import { z } from "zod";

const UuidSchema = z.uuid();
const UtcDateTimeSchema = z.string().datetime({ offset: true });
const EmailSchema = z.email().max(320);
const PasswordSchema = z.string().min(1).max(1024);
const KeyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const CloudErrorCodes = [
  "REQUEST_INVALID",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_VERIFICATION_INVALID",
  "AUTH_TOKEN_INVALID",
  "AUTH_TOKEN_EXPIRED",
  "AUTH_REFRESH_REPLAYED",
  "AUTH_SESSION_REVOKED",
  "AUTH_RECOVERY_INVALID",
  "ACCOUNT_FORBIDDEN",
  "DEVICE_NOT_FOUND",
  "DEVICE_LIMIT_REACHED",
  "RATE_LIMITED",
  "UPDATE_POLICY_NOT_AVAILABLE",
  "UPDATE_POLICY_INVALID_REQUEST",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;

export const CloudErrorSchema = z
  .object({
    code: z.enum(CloudErrorCodes),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    requestId: UuidSchema,
  })
  .strict();

export const ApiErrorResponseSchema = z.object({ error: CloudErrorSchema }).strict();

export const AccountEntitlementSchema = z
  .object({ code: z.string().regex(/^[A-Z][A-Z0-9_.-]{0,63}$/), enabled: z.boolean() })
  .strict();

export const AccountViewSchema = z
  .object({
    userId: UuidSchema,
    email: EmailSchema,
    emailVerified: z.boolean(),
    entitlements: z.array(AccountEntitlementSchema).max(128),
    createdAt: UtcDateTimeSchema,
  })
  .strict();

export const DeviceViewSchema = z
  .object({
    deviceId: UuidSchema,
    label: z.string().min(1).max(80),
    createdAt: UtcDateTimeSchema,
    lastSeenAt: UtcDateTimeSchema.nullable(),
    revokedAt: UtcDateTimeSchema.nullable(),
    current: z.boolean(),
  })
  .strict();

export const OfflineGrantPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    grantId: UuidSchema,
    userId: UuidSchema,
    deviceId: UuidSchema,
    issuedAt: UtcDateTimeSchema,
    expiresAt: UtcDateTimeSchema,
    entitlements: z.array(AccountEntitlementSchema).max(128),
    keyId: KeyIdSchema,
  })
  .strict();

export const OfflineGrantEnvelopeSchema = z
  .object({
    envelopeVersion: z.literal(1),
    payload: OfflineGrantPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export const AuthTokensSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accessToken: z.string().min(32).max(8192),
    accessExpiresAt: UtcDateTimeSchema,
    refreshToken: z.string().min(32).max(8192),
    refreshExpiresAt: UtcDateTimeSchema,
    refreshAbsoluteExpiresAt: UtcDateTimeSchema,
  })
  .strict();

export const AuthResultSchema = z
  .object({
    requestId: UuidSchema,
    sessionId: UuidSchema,
    account: AccountViewSchema,
    device: DeviceViewSchema,
    tokens: AuthTokensSchema,
    offlineGrant: OfflineGrantEnvelopeSchema.nullable(),
  })
  .strict();

export const AcceptedResponseSchema = z
  .object({ requestId: UuidSchema, status: z.literal("ACCEPTED") })
  .strict();
export const OperationSucceededResponseSchema = z
  .object({ requestId: UuidSchema, status: z.literal("SUCCEEDED") })
  .strict();
export const AccountResponseSchema = z
  .object({ requestId: UuidSchema, account: AccountViewSchema })
  .strict();
export const DeviceListResponseSchema = z
  .object({
    requestId: UuidSchema,
    devices: z.array(DeviceViewSchema).max(100),
    nextCursor: z.string().max(512).nullable(),
  })
  .strict();
export const DeviceRevocationResponseSchema = z
  .object({ requestId: UuidSchema, deviceId: UuidSchema, revoked: z.literal(true) })
  .strict();

export const RegisterRequestSchema = z
  .object({ email: EmailSchema, password: PasswordSchema })
  .strict();
export const VerifyEmailRequestSchema = z
  .object({ verificationToken: z.string().min(16).max(4096) })
  .strict();
export const EmailAddressRequestSchema = z.object({ email: EmailSchema }).strict();
export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    device: z
      .object({
        label: z.string().min(1).max(80),
        publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .strict(),
  })
  .strict();
export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(32).max(8192) })
  .strict();
export const ResetPasswordRequestSchema = z
  .object({ resetToken: z.string().min(16).max(4096), newPassword: PasswordSchema })
  .strict();
export const ChangePasswordRequestSchema = z
  .object({ currentPassword: PasswordSchema, newPassword: PasswordSchema })
  .strict();

export type CloudErrorCode = (typeof CloudErrorCodes)[number];
export type AccountEntitlement = z.infer<typeof AccountEntitlementSchema>;
export type AccountView = z.infer<typeof AccountViewSchema>;
export type DeviceView = z.infer<typeof DeviceViewSchema>;
export type OfflineGrantEnvelope = z.infer<typeof OfflineGrantEnvelopeSchema>;
export type AuthTokens = z.infer<typeof AuthTokensSchema>;
export type AuthResult = z.infer<typeof AuthResultSchema>;
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;
export type OperationSucceededResponse = z.infer<typeof OperationSucceededResponseSchema>;
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export type DeviceRevocationResponse = z.infer<typeof DeviceRevocationResponseSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;
export type EmailAddressRequest = z.infer<typeof EmailAddressRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
