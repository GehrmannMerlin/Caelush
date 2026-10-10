import { createHash } from "node:crypto";
import { DpapiVault, VaultUnavailableError } from "./vault.js";

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CREDENTIAL_LENGTH = 16_384;
const PROVIDER_CREDENTIAL_VERSION = 1;

type ProviderCredentialSource = "NONE" | "LOCAL";

export interface ProviderCredentialVaultStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly source: ProviderCredentialSource;
  readonly writable: boolean;
  readonly updatedAt?: number;
}

interface ProviderCredentialRecord {
  readonly schemaVersion: 1;
  readonly cloudUserId: string;
  readonly profileId: string;
  readonly providerId: string;
  readonly credentialVersion: 1;
  readonly secretValue: string;
  readonly updatedAtMs: number;
}

/**
 * Provider credentials extend the existing D3 DPAPI document. Identity is hashed into the
 * document key; the duplicated identity fields are checked on every read before a secret is used.
 */
export class ProviderCredentialVault {
  constructor(
    private readonly vault: DpapiVault,
    private readonly now: () => number = Date.now,
  ) {}

  async describe(
    cloudUserId: string,
    profileId: string,
    providerId: string,
  ): Promise<ProviderCredentialVaultStatus> {
    const record = await this.read(cloudUserId, profileId, providerId);
    return record === undefined
      ? { providerId, configured: false, source: "NONE", writable: true }
      : {
          providerId,
          configured: true,
          source: "LOCAL",
          writable: true,
          updatedAt: record.updatedAtMs,
        };
  }

  async resolve(
    cloudUserId: string,
    profileId: string,
    providerId: string,
  ): Promise<string | undefined> {
    return (await this.read(cloudUserId, profileId, providerId))?.secretValue;
  }

  async set(
    cloudUserId: string,
    profileId: string,
    providerId: string,
    secretValue: string,
  ): Promise<ProviderCredentialVaultStatus> {
    const identity = normalizeIdentity(cloudUserId, profileId, providerId);
    if (secretValue.trim().length === 0 || secretValue.length > MAX_CREDENTIAL_LENGTH) {
      throw new VaultUnavailableError(
        "The Provider credential is invalid or exceeds its size limit.",
      );
    }
    const updatedAtMs = this.now();
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new VaultUnavailableError("The Provider credential could not be stored safely.");
    }
    const record: ProviderCredentialRecord = {
      schemaVersion: 1,
      ...identity,
      credentialVersion: PROVIDER_CREDENTIAL_VERSION,
      secretValue,
      updatedAtMs,
    };
    await this.vault.set(providerCredentialVaultKey(identity), record);
    return {
      providerId: identity.providerId,
      configured: true,
      source: "LOCAL",
      writable: true,
      updatedAt: updatedAtMs,
    };
  }

  async unset(cloudUserId: string, profileId: string, providerId: string): Promise<void> {
    const identity = normalizeIdentity(cloudUserId, profileId, providerId);
    await this.vault.delete(providerCredentialVaultKey(identity));
  }

  private async read(
    cloudUserId: string,
    profileId: string,
    providerId: string,
  ): Promise<ProviderCredentialRecord | undefined> {
    const identity = normalizeIdentity(cloudUserId, profileId, providerId);
    const value = await this.vault.get(providerCredentialVaultKey(identity));
    if (value === null) return undefined;
    if (!isProviderCredentialRecord(value, identity)) {
      throw new VaultUnavailableError("The saved Provider credential record is damaged.");
    }
    return value;
  }
}

function normalizeIdentity(
  cloudUserId: string,
  profileId: string,
  providerId: string,
): Pick<ProviderCredentialRecord, "cloudUserId" | "profileId" | "providerId"> {
  if (
    !USER_ID_PATTERN.test(cloudUserId) ||
    !PROFILE_ID_PATTERN.test(profileId) ||
    !PROVIDER_ID_PATTERN.test(providerId)
  ) {
    throw new VaultUnavailableError("The Provider credential identity is invalid.");
  }
  return {
    cloudUserId: cloudUserId.toLowerCase(),
    profileId,
    providerId,
  };
}

function providerCredentialVaultKey(
  identity: Pick<ProviderCredentialRecord, "cloudUserId" | "profileId" | "providerId">,
): string {
  return createHash("sha256")
    .update("caelush-desktop-provider-credential-v1\0", "utf8")
    .update(identity.cloudUserId, "utf8")
    .update("\0", "utf8")
    .update(identity.profileId, "utf8")
    .update("\0", "utf8")
    .update(identity.providerId, "utf8")
    .update("\0", "utf8")
    .update(String(PROVIDER_CREDENTIAL_VERSION), "utf8")
    .digest("hex");
}

function isProviderCredentialRecord(
  value: unknown,
  identity: Pick<ProviderCredentialRecord, "cloudUserId" | "profileId" | "providerId">,
): value is ProviderCredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "cloudUserId,credentialVersion,profileId,providerId,schemaVersion,secretValue,updatedAtMs" &&
    record.schemaVersion === 1 &&
    record.cloudUserId === identity.cloudUserId &&
    record.profileId === identity.profileId &&
    record.providerId === identity.providerId &&
    record.credentialVersion === PROVIDER_CREDENTIAL_VERSION &&
    typeof record.secretValue === "string" &&
    record.secretValue.trim().length > 0 &&
    record.secretValue.length <= MAX_CREDENTIAL_LENGTH &&
    typeof record.updatedAtMs === "number" &&
    Number.isSafeInteger(record.updatedAtMs) &&
    record.updatedAtMs >= 0
  );
}
