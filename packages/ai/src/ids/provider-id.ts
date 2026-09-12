/**
 * Provider identity.
 *
 * A `ProviderId` names a configured provider connection (endpoint, credentials,
 * default API dialect). It is deliberately a bare string with a validated shape
 * rather than a branded type, because provider ids are configuration data that
 * crosses the host composition boundary.
 */
export type ProviderId = string;

/**
 * The frozen provider identifier shape.
 *
 * Lowercase leading letter, then lowercase letters, digits, `_` and `-`.
 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Runtime validation for a provider identifier. */
export function isValidProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value);
}
