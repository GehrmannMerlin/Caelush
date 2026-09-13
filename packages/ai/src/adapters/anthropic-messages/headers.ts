import { createAIError } from "../../errors/ai-error.js";
import type { AnthropicMessagesConnectionMetadata } from "./adapter-metadata.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { ResolvedProviderConnection } from "../../providers/resolved-provider-connection.js";

/** The stable native protocol version this dialect speaks by default. */
export const ANTHROPIC_MESSAGES_DEFAULT_VERSION = "2023-06-01";

/** Where the resolved native version came from. */
export type AnthropicAuthMode = "api-key" | "bearer";

/**
 * The native request headers plus the authentication scheme that produced them.
 *
 * The scheme is returned rather than inferred later so a test — and an operator
 * reading a diagnostic — can tell which credential mechanism was used without ever
 * seeing the credential itself.
 */
export interface AnthropicMessagesHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly authMode: AnthropicAuthMode;
  readonly version: string;
}

/**
 * Build the native Anthropic Messages headers for one provider turn.
 *
 * Resolution order, highest priority last:
 *
 * ```text
 * 1 dialect defaults        content-type: application/json
 *                           anthropic-version: <default>
 * 2 connection headers      provider static headers, then credential headers
 *                           (already merged by the gateway)
 * 3 authentication          x-api-key, or Authorization: Bearer on explicit opt-in
 * ```
 *
 * `anthropic-version` is only defaulted, never overwritten: a provider that
 * declares its own version in static headers keeps it.
 *
 * Header lookup is case-insensitive because HTTP header names are, and a
 * configuration that sets `Anthropic-Version` must not end up sending two versions.
 */
export function buildAnthropicMessagesHeaders(
  connection: ResolvedProviderConnection,
  metadata: AnthropicMessagesConnectionMetadata,
  model: ModelRef,
): AnthropicMessagesHeaders {
  const normalized = new Map<string, string>();
  const seen = new Map<string, string>();

  const set = (name: string, value: string): void => {
    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) normalized.delete(previous);
    seen.set(key, name);
    normalized.set(name, value);
  };

  set("content-type", "application/json");
  set("anthropic-version", ANTHROPIC_MESSAGES_DEFAULT_VERSION);

  // Provider and credential headers win over the dialect defaults, and the last
  // declaration of a name wins, so casing never produces a duplicate header.
  for (const [name, value] of Object.entries(connection.headers)) set(name, value);

  const { authMode, header } = resolveAuthentication(connection, metadata, model);
  set(header.name, header.value);

  return {
    headers: Object.freeze(Object.fromEntries(normalized)),
    authMode,
    version: findHeader(normalized, "anthropic-version") ?? ANTHROPIC_MESSAGES_DEFAULT_VERSION,
  };
}

/**
 * Resolve which credential mechanism this connection uses.
 *
 * The dialect default is direct Anthropic semantics: `apiKey` becomes `x-api-key`.
 * A bearer token is only ever sent when the connection explicitly declares
 * `authMode: "bearer"`; the adapter never guesses, because guessing would mean
 * choosing which secret to leak to which host.
 *
 * When both a key and a bearer token are present without an explicit mode the
 * request fails closed: sending two credentials to a provider that asked for one is
 * exactly the mistake that leaks a secret to the wrong place.
 */
function resolveAuthentication(
  connection: ResolvedProviderConnection,
  metadata: AnthropicMessagesConnectionMetadata,
  model: ModelRef,
): { readonly authMode: AnthropicAuthMode; readonly header: { name: string; value: string } } {
  const { apiKey, bearerToken } = connection.credentials;
  const explicit = metadata.authMode;
  const hasKey = apiKey !== undefined && apiKey.length > 0;
  const hasBearer = bearerToken !== undefined && bearerToken.length > 0;

  if (explicit === "bearer") {
    if (!hasBearer) {
      throw authentication(
        `AI provider "${connection.providerId}" declares anthropicMessages.authMode "bearer" but resolved no bearer token.`,
        model,
      );
    }
    return {
      authMode: "bearer",
      header: { name: "authorization", value: `Bearer ${bearerToken}` },
    };
  }

  if (explicit === "api-key") {
    if (!hasKey) {
      throw authentication(
        `AI provider "${connection.providerId}" declares anthropicMessages.authMode "api-key" but resolved no API key.`,
        model,
      );
    }
    return { authMode: "api-key", header: { name: "x-api-key", value: apiKey } };
  }

  if (hasKey && hasBearer) {
    throw authentication(
      `AI provider "${connection.providerId}" resolved both an API key and a bearer token without declaring anthropicMessages.authMode, so the dialect cannot choose one safely.`,
      model,
    );
  }

  if (hasBearer) {
    // Unambiguous: a single bearer token cannot be sent through `x-api-key`.
    return {
      authMode: "bearer",
      header: { name: "authorization", value: `Bearer ${bearerToken}` },
    };
  }

  if (!hasKey) {
    throw authentication(
      `AI provider "${connection.providerId}" resolved no API key for the Anthropic Messages dialect.`,
      model,
    );
  }
  return { authMode: "api-key", header: { name: "x-api-key", value: apiKey } };
}

function findHeader(headers: ReadonlyMap<string, string>, name: string): string | undefined {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function authentication(message: string, model: ModelRef) {
  return createAIError("AI_AUTHENTICATION", message, {
    providerId: model.provider,
    model,
  });
}
