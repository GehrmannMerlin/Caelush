/**
 * Runtime-only provider credentials.
 *
 * Credentials exist for the duration of one provider attempt. They must never be
 * persisted, published, logged, or projected into a descriptor, an event, a
 * durable record or a client DTO.
 */
export interface ProviderCredentials {
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
}

/**
 * Resolves credentials for one attempt.
 *
 * Resolution is asynchronous and abort-aware: an environment lookup, a keychain
 * read or a secret-manager call is legitimate here, and all of them must be able
 * to give up when the invocation is aborted.
 */
export interface ProviderCredentialResolver {
  resolve(signal: AbortSignal): Promise<ProviderCredentials>;
}
