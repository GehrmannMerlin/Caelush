import { createAIError, type ProviderCredentials } from "@caelush/ai";
import type { ProviderCredentialRepository, ProviderCredentialStatus } from "@caelush/storage";

export interface RuntimeProviderCredentialAuthorityOptions {
  readonly repository: Omit<ProviderCredentialRepository, "resolve"> & {
    resolve(providerId: string, signal?: AbortSignal): Promise<string | undefined>;
  };
  /** A snapshot of process environment values; values are read on every resolve. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Compatibility input for the existing programmatic startup-provider seam. */
  readonly startupCredentials?: ReadonlyMap<string, string>;
}

export interface RuntimeProviderCredentialStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly source: "NONE" | "LOCAL" | "ENVIRONMENT";
  readonly writable: boolean;
  readonly updatedAt?: number;
}

export class EnvironmentCredentialReadOnlyError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super("This provider credential is supplied by the environment and is read-only.");
    this.name = "EnvironmentCredentialReadOnlyError";
    this.providerId = providerId;
  }
}

/**
 * The daemon's runtime credential authority.
 *
 * Environment values are checked first on every invocation, then SQLite is read.
 * The AI binding receives this object as a resolver port; it never captures a
 * startup API-key string and the immutable AI ProviderRegistry is never changed.
 */
export interface RuntimeProviderCredentialAuthority {
  describe(providerId: string): Promise<RuntimeProviderCredentialStatus>;
  resolve(providerId: string, signal: AbortSignal): Promise<ProviderCredentials>;
  set(providerId: string, apiKey: string): Promise<RuntimeProviderCredentialStatus>;
  unset(providerId: string): Promise<void>;
}

export function createRuntimeProviderCredentialAuthority(
  options: RuntimeProviderCredentialAuthorityOptions,
): RuntimeProviderCredentialAuthority {
  const environment = options.environment ?? {};

  const environmentCredential = (providerId: string): string | undefined => {
    const environmentProvider = environment.CAELUSH_PROVIDER_ID;
    if (environmentProvider !== providerId) return undefined;
    const apiKey = environment.CAELUSH_PROVIDER_API_KEY;
    return apiKey === undefined || apiKey.trim().length === 0 ? undefined : apiKey;
  };

  const startupCredential = (providerId: string): string | undefined => {
    const value = options.startupCredentials?.get(providerId);
    return value === undefined || value.trim().length === 0 ? undefined : value;
  };

  const environmentOrStartupCredential = (providerId: string): string | undefined =>
    environmentCredential(providerId) ?? startupCredential(providerId);

  return {
    async describe(providerId) {
      if (environmentOrStartupCredential(providerId) !== undefined) {
        return {
          providerId,
          configured: true,
          source: "ENVIRONMENT",
          writable: false,
        };
      }
      const local = await options.repository.describe(providerId);
      return toRuntimeStatus(local);
    },

    async resolve(providerId, signal) {
      if (signal.aborted) {
        throw createAIError("AI_ABORTED", "The provider credential resolution was cancelled.", {
          providerId,
        });
      }
      const environmentValue = environmentOrStartupCredential(providerId);
      if (environmentValue !== undefined) return { apiKey: environmentValue };

      let local: string | undefined;
      try {
        local = await options.repository.resolve(providerId, signal);
      } catch (error) {
        if (signal.aborted) {
          throw createAIError("AI_ABORTED", "The provider credential resolution was cancelled.", {
            providerId,
          });
        }
        throw error;
      }
      if (signal.aborted) {
        throw createAIError("AI_ABORTED", "The provider credential resolution was cancelled.", {
          providerId,
        });
      }
      if (local === undefined) {
        throw createAIError("AI_AUTHENTICATION", "No credential is configured for this provider.", {
          providerId,
        });
      }
      return { apiKey: local };
    },

    async set(providerId, apiKey) {
      if (environmentOrStartupCredential(providerId) !== undefined) {
        throw new EnvironmentCredentialReadOnlyError(providerId);
      }
      return toRuntimeStatus(await options.repository.set(providerId, apiKey));
    },

    async unset(providerId) {
      if (environmentOrStartupCredential(providerId) !== undefined) {
        throw new EnvironmentCredentialReadOnlyError(providerId);
      }
      await options.repository.unset(providerId);
    },
  };
}

/** Bind one provider identity to the live authority without capturing a secret. */
export function createRuntimeProviderCredentialResolver(
  authority: RuntimeProviderCredentialAuthority,
  providerId: string,
): { resolve(signal: AbortSignal): Promise<ProviderCredentials> } {
  return {
    resolve: (signal) => authority.resolve(providerId, signal),
  };
}

function toRuntimeStatus(status: ProviderCredentialStatus): RuntimeProviderCredentialStatus {
  return {
    providerId: status.providerId,
    configured: status.configured,
    source: status.source,
    writable: status.writable,
    ...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
  };
}
