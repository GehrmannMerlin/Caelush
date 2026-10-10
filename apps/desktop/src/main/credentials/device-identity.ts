import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { OfflineGrantError, publicKeyRawFromPrivate } from "../offline/grant.js";
import { DpapiVault } from "./vault.js";

export const ACTIVE_ACCOUNT_INDEX_KEY = "0".repeat(64);
const DEVICE_RECORD_VERSION = 1;

export interface DeviceIdentity {
  readonly privateKey: KeyObject;
  readonly privateKeyPkcs8Base64: string;
  readonly publicKeyRaw: Buffer;
  readonly publicKeyBase64Url: string;
}

export interface StoredAccountRecord {
  readonly schemaVersion: 1;
  readonly normalizedEmail: string;
  readonly userId: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: string | null;
  readonly deviceId: string | null;
  readonly deviceCreatedAt: string | null;
  readonly deviceLastSeenAt: string | null;
  readonly deviceLabel: string;
  readonly devicePrivateKeyPkcs8Base64: string;
  readonly devicePublicKeyBase64Url: string;
  readonly sessionId: string | null;
  readonly refreshToken: string | null;
  readonly rotationUncertain: boolean;
  readonly offlineGrant: unknown | null;
  readonly lastTrustedServerTime: string | null;
  readonly lastAcceptedTime: string | null;
  readonly entitlements: readonly { readonly code: string; readonly enabled: boolean }[];
  readonly accountEmail: string;
}

export function accountVaultKey(email: string): string {
  const normalized = normalizeEmail(email);
  return createHash("sha256")
    .update("caelush-desktop-account-v1\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new OfflineGrantError("ACCOUNT_EMAIL_INVALID", "Enter a valid email address.");
  }
  return normalized;
}

export async function getOrCreateDeviceIdentity(
  vault: DpapiVault,
  email: string,
): Promise<{
  readonly accountKey: string;
  readonly record: StoredAccountRecord;
  readonly identity: DeviceIdentity;
}> {
  const normalizedEmail = normalizeEmail(email);
  const accountKey = accountVaultKey(normalizedEmail);
  const stored = await vault.get(accountKey);
  if (stored === null) {
    const identity = generateDeviceIdentity();
    const record: StoredAccountRecord = {
      schemaVersion: DEVICE_RECORD_VERSION,
      normalizedEmail,
      userId: null,
      emailVerified: false,
      createdAt: null,
      deviceId: null,
      deviceCreatedAt: null,
      deviceLastSeenAt: null,
      deviceLabel: "Caelush Desktop",
      devicePrivateKeyPkcs8Base64: identity.privateKeyPkcs8Base64,
      devicePublicKeyBase64Url: identity.publicKeyBase64Url,
      sessionId: null,
      refreshToken: null,
      rotationUncertain: false,
      offlineGrant: null,
      lastTrustedServerTime: null,
      lastAcceptedTime: null,
      entitlements: [],
      accountEmail: normalizedEmail,
    };
    await vault.set(accountKey, record);
    return { accountKey, record, identity };
  }
  const record = parseStoredAccountRecord(stored, normalizedEmail);
  const identity = identityFromRecord(record);
  return { accountKey, record, identity };
}

export function generateDeviceIdentity(): DeviceIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const exported = privateKey.export({ format: "der", type: "pkcs8" });
  const privateKeyPkcs8Base64 = Buffer.isBuffer(exported)
    ? exported.toString("base64")
    : Buffer.from(exported).toString("base64");
  const publicKeyRaw = publicKeyRawFromPrivate(privateKey);
  return {
    privateKey,
    privateKeyPkcs8Base64,
    publicKeyRaw,
    publicKeyBase64Url: publicKeyRaw.toString("base64url"),
  };
}

export function identityFromRecord(record: StoredAccountRecord): DeviceIdentity {
  try {
    const der = Buffer.from(record.devicePrivateKeyPkcs8Base64, "base64");
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicKeyRaw = publicKeyRawFromPrivate(privateKey);
    if (publicKeyRaw.toString("base64url") !== record.devicePublicKeyBase64Url) {
      throw new Error("device key mismatch");
    }
    return {
      privateKey,
      privateKeyPkcs8Base64: record.devicePrivateKeyPkcs8Base64,
      publicKeyRaw,
      publicKeyBase64Url: record.devicePublicKeyBase64Url,
    };
  } catch {
    throw new OfflineGrantError("DEVICE_KEY_INVALID", "The saved device identity is damaged.");
  }
}

export function parseStoredAccountRecord(
  value: unknown,
  expectedEmail?: string,
): StoredAccountRecord {
  if (!isRecord(value) || value.schemaVersion !== DEVICE_RECORD_VERSION) {
    throw new OfflineGrantError("ACCOUNT_RECORD_INVALID", "The saved account record is damaged.");
  }
  const requiredString = (name: string): string => {
    const entry = value[name];
    if (typeof entry !== "string")
      throw new OfflineGrantError("ACCOUNT_RECORD_INVALID", "The saved account record is damaged.");
    return entry;
  };
  const nullableString = (name: string): string | null => {
    const entry = value[name];
    if (entry !== null && typeof entry !== "string")
      throw new OfflineGrantError("ACCOUNT_RECORD_INVALID", "The saved account record is damaged.");
    return entry as string | null;
  };
  const userId = nullableString("userId");
  const deviceId = nullableString("deviceId");
  const deviceCreatedAt = nullableString("deviceCreatedAt");
  const deviceLastSeenAt = nullableString("deviceLastSeenAt");
  const sessionId = nullableString("sessionId");
  const normalizedEmail = requiredString("normalizedEmail");
  const accountEmail = requiredString("accountEmail");
  const lastTrustedServerTime = nullableString("lastTrustedServerTime");
  const lastAcceptedTime = nullableString("lastAcceptedTime");
  const createdAt = nullableString("createdAt");
  const refreshToken = nullableString("refreshToken");
  const offlineGrant = value.offlineGrant;
  const entitlements = value.entitlements;
  if (
    (expectedEmail !== undefined && normalizedEmail !== expectedEmail) ||
    normalizeEmail(normalizedEmail) !== normalizedEmail ||
    normalizeEmail(accountEmail) !== normalizedEmail ||
    (userId !== null && !isUuid(userId)) ||
    (deviceId !== null && !isUuid(deviceId)) ||
    (deviceCreatedAt !== null && !validDateString(deviceCreatedAt)) ||
    (deviceLastSeenAt !== null && !validDateString(deviceLastSeenAt)) ||
    (sessionId !== null && !isUuid(sessionId)) ||
    (createdAt !== null && !validDateString(createdAt)) ||
    (lastTrustedServerTime !== null && !validDateString(lastTrustedServerTime)) ||
    (lastAcceptedTime !== null && !validDateString(lastAcceptedTime)) ||
    typeof value.emailVerified !== "boolean" ||
    typeof value.rotationUncertain !== "boolean" ||
    (refreshToken !== null && (refreshToken.length < 32 || refreshToken.length > 8192)) ||
    typeof value.deviceLabel !== "string" ||
    value.deviceLabel.length < 1 ||
    value.deviceLabel.length > 80 ||
    typeof value.devicePrivateKeyPkcs8Base64 !== "string" ||
    typeof value.devicePublicKeyBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.devicePublicKeyBase64Url) ||
    !Array.isArray(entitlements) ||
    entitlements.length > 128 ||
    (offlineGrant !== null && !isRecord(offlineGrant))
  ) {
    throw new OfflineGrantError("ACCOUNT_RECORD_INVALID", "The saved account record is damaged.");
  }
  return {
    schemaVersion: 1,
    normalizedEmail,
    userId,
    emailVerified: value.emailVerified,
    createdAt,
    deviceId,
    deviceCreatedAt,
    deviceLastSeenAt,
    deviceLabel: value.deviceLabel,
    devicePrivateKeyPkcs8Base64: value.devicePrivateKeyPkcs8Base64,
    devicePublicKeyBase64Url: value.devicePublicKeyBase64Url,
    sessionId,
    refreshToken,
    rotationUncertain: value.rotationUncertain,
    offlineGrant,
    lastTrustedServerTime,
    lastAcceptedTime,
    entitlements: entitlements as StoredAccountRecord["entitlements"],
    accountEmail,
  };
}

export function writeActiveAccount(vault: DpapiVault, accountKey: string): Promise<void> {
  return vault.set(ACTIVE_ACCOUNT_INDEX_KEY, { accountKey });
}

export async function readActiveAccount(vault: DpapiVault): Promise<string | null> {
  const value = await vault.get(ACTIVE_ACCOUNT_INDEX_KEY);
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.accountKey !== "string" ||
    !/^[A-Fa-f0-9]{64}$/.test(value.accountKey)
  ) {
    throw new OfflineGrantError(
      "ACTIVE_ACCOUNT_INVALID",
      "The saved account selection is damaged.",
    );
  }
  return value.accountKey;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validDateString(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.endsWith("Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
