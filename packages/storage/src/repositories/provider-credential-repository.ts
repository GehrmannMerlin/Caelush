import type { CaelushDatabase } from "../database.js";
import { StorageError } from "../errors.js";

export type ProviderCredentialSource = "NONE" | "LOCAL";

/** Safe status for one provider; it deliberately has no secret-bearing member. */
export interface ProviderCredentialStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly source: ProviderCredentialSource;
  readonly writable: boolean;
  readonly updatedAt?: number;
}

/**
 * Storage-side Credential Authority.
 *
 * `resolve` is the only secret-bearing operation and is intended for the daemon's
 * runtime resolver. It must never be used to form a public response or diagnostic.
 */
export interface ProviderCredentialRepository {
  describe(providerId: string): Promise<ProviderCredentialStatus>;
  set(providerId: string, secretValue: string): Promise<ProviderCredentialStatus>;
  unset(providerId: string): Promise<void>;
  resolve(providerId: string): Promise<string | undefined>;
}

interface CredentialRow {
  provider_id: string;
  secret_value: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const MAX_CREDENTIAL_LENGTH = 16_384;

function assertProviderId(providerId: string): void {
  if (providerId.trim().length === 0) throw new Error("Provider id must not be empty.");
  if (providerId.length > 256) throw new Error("Provider id is too long.");
}

function assertSecretValue(secretValue: string): void {
  if (secretValue.trim().length === 0) throw new Error("API key must not be empty.");
  if (secretValue.length > MAX_CREDENTIAL_LENGTH) {
    throw new Error("API key is too long.");
  }
}

function mapStorageError(error: unknown, action: string, providerId: string): never {
  if (error instanceof StorageError) throw error;
  // Never interpolate a secret or a driver message that might echo bound values.
  throw new StorageError(`Unable to ${action} provider credential for ${providerId}.`, {
    cause: error,
  });
}

function status(providerId: string, row: CredentialRow | undefined): ProviderCredentialStatus {
  return row === undefined
    ? { providerId, configured: false, source: "NONE", writable: true }
    : {
        providerId,
        configured: true,
        source: "LOCAL",
        writable: true,
        updatedAt: row.updated_at_ms,
      };
}

export class SqliteProviderCredentialRepository implements ProviderCredentialRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async describe(providerId: string): Promise<ProviderCredentialStatus> {
    assertProviderId(providerId);
    try {
      const row = this.database.client
        .prepare(
          `SELECT provider_id, secret_value, created_at_ms, updated_at_ms
           FROM ai_provider_credentials WHERE provider_id = ?`,
        )
        .get(providerId) as CredentialRow | undefined;
      return status(providerId, row);
    } catch (error) {
      mapStorageError(error, "describe", providerId);
    }
  }

  async set(providerId: string, secretValue: string): Promise<ProviderCredentialStatus> {
    assertProviderId(providerId);
    assertSecretValue(secretValue);
    const now = Date.now();
    try {
      this.database.client
        .prepare(
          `INSERT INTO ai_provider_credentials
             (provider_id, secret_value, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET
             secret_value = excluded.secret_value,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(providerId, secretValue, now, now);
      return {
        providerId,
        configured: true,
        source: "LOCAL",
        writable: true,
        updatedAt: now,
      };
    } catch (error) {
      mapStorageError(error, "set", providerId);
    }
  }

  async unset(providerId: string): Promise<void> {
    assertProviderId(providerId);
    try {
      this.database.client
        .prepare("DELETE FROM ai_provider_credentials WHERE provider_id = ?")
        .run(providerId);
    } catch (error) {
      mapStorageError(error, "delete", providerId);
    }
  }

  async resolve(providerId: string): Promise<string | undefined> {
    assertProviderId(providerId);
    try {
      const row = this.database.client
        .prepare("SELECT secret_value FROM ai_provider_credentials WHERE provider_id = ?")
        .get(providerId) as { secret_value: string } | undefined;
      return row?.secret_value;
    } catch (error) {
      mapStorageError(error, "resolve", providerId);
    }
  }
}
