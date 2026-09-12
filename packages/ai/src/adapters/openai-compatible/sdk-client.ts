import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAIError } from "../../errors/ai-error.js";
import type { LanguageModel } from "ai";
import type { ResolvedProviderConnection } from "../../providers/resolved-provider-connection.js";

/** The configured upstream provider, typed through the pinned SDK factory. */
export type OpenAICompatibleUpstream = ReturnType<
  typeof createOpenAICompatible<string, string, string, string>
>;

/** A ready-to-use upstream client for one resolved provider connection. */
export interface OpenAICompatibleClient {
  /** The provider name the SDK will key provider options by. */
  readonly providerName: string;
  readonly upstream: OpenAICompatibleUpstream;
}

/**
 * Create the upstream OpenAI-compatible client from a resolved connection.
 *
 * The endpoint, the credentials, the headers, the query parameters and the
 * transport all come from {@link ResolvedProviderConnection}, which the gateway
 * built from the provider registry. `ModelRef.baseUrl` is deliberately never read
 * here: the provider binding owns the endpoint, and a legacy hint must not be able
 * to redirect a request.
 *
 * The SDK adds `Authorization: Bearer <apiKey>` before the explicit headers, so an
 * explicit header wins over the key. That is the SDK's own documented precedence
 * and the behaviour this dialect has always had.
 */
export function createOpenAICompatibleClient(
  connection: ResolvedProviderConnection,
): OpenAICompatibleClient {
  const headers = buildHeaders(connection);
  const queryParams = connection.queryParams;

  const upstream = createOpenAICompatible<string, string, string, string>({
    name: connection.providerId,
    baseURL: connection.endpoint,
    // Streaming usage is required for the frozen `usage` event and `finalUsage`.
    includeUsage: true,
    ...(connection.credentials.apiKey === undefined
      ? {}
      : { apiKey: connection.credentials.apiKey }),
    ...(headers === undefined ? {} : { headers }),
    ...(Object.keys(queryParams).length === 0 ? {} : { queryParams: { ...queryParams } }),
    ...(connection.transport?.fetch === undefined ? {} : { fetch: connection.transport.fetch }),
  });

  return { providerName: connection.providerId, upstream };
}

/**
 * Merge the explicit headers with a bearer token credential.
 *
 * `apiKey` and `bearerToken` are two ways to express the same credential. When
 * both are present the API key wins because it is the dialect's native mechanism,
 * and a bearer token is only materialised as a header when no key exists. The
 * endpoint is never taken from anywhere but the connection.
 */
function buildHeaders(connection: ResolvedProviderConnection): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...connection.headers };
  const { apiKey, bearerToken } = connection.credentials;

  if (apiKey === undefined && bearerToken !== undefined && bearerToken.length > 0) {
    const hasAuthorization = Object.keys(headers).some(
      (name) => name.toLowerCase() === "authorization",
    );
    if (!hasAuthorization) headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** Resolve the chat model for one model id. */
export function openAICompatibleChatModel(
  client: OpenAICompatibleClient,
  modelId: string,
): LanguageModel {
  if (modelId.length === 0) {
    throw createAIError("AI_INVALID_REQUEST", "OpenAI-compatible model id must not be empty.");
  }
  return client.upstream.chatModel(modelId);
}
