import type { ApiId } from "../ids/api-id.js";
import type { ProviderId } from "../ids/provider-id.js";

/**
 * The safe, publicly reportable view of a configured provider.
 *
 * A descriptor is what a host may print, expose to a client, or attach to a
 * diagnostic. It carries identity and policy only — never an endpoint, an API
 * key, a bearer token, a secret header, a secret query parameter, or the
 * credential resolver itself.
 */
export interface AIProviderDescriptor {
  readonly id: ProviderId;
  readonly defaultApi: ApiId;

  /**
   * Whether this provider is usable.
   *
   * Phase 2A always reports `true`: the registry builder refuses a binding that
   * has no credential resolver, so nothing unusable can be registered. The flag
   * exists so a later phase can report a registered-but-uncredentialed provider
   * without disclosing why it is unusable.
   */
  readonly configured: boolean;

  readonly allowedModels?: readonly string[];
  readonly allowUnknownModels: boolean;
}

/** The exact descriptor key set. */
export const PROVIDER_DESCRIPTOR_KEYS = [
  "id",
  "defaultApi",
  "configured",
  "allowedModels",
  "allowUnknownModels",
] as const satisfies readonly (keyof AIProviderDescriptor)[];
