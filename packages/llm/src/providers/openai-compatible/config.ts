import { assertProviderEndpoint } from "@caelush/ai";
import { LLMProviderError } from "../../errors.js";
import { ProviderIdSchema } from "../../provider.js";
import type { LLMCapabilities } from "../../capabilities.js";
import { LLMCapabilitiesSchema } from "../../capabilities.js";
import type { ProviderId } from "../../provider.js";

/** The options an existing consumer already passes to this factory. */
export interface OpenAICompatibleLLMProviderOptions {
  readonly id: ProviderId;
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly capabilities?: Partial<LLMCapabilities>;
  readonly allowedModels?: readonly string[];
  readonly fetch?: typeof fetch;
}

/** The validated, defensively copied options the facade works from. */
export interface NormalizedOpenAICompatibleLLMProviderOptions {
  readonly id: ProviderId;
  readonly baseURL: string;
  readonly apiKey: string | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly queryParams: Record<string, string> | undefined;
  readonly capabilities: LLMCapabilities;
  readonly allowedModels: readonly string[] | undefined;
  readonly fetch: typeof fetch | undefined;
}

const defaultCapabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

/**
 * Validate and copy the legacy provider options.
 *
 * The endpoint is checked by importing the AI core's own `assertProviderEndpoint`,
 * so this package keeps no second URL-validation implementation. An AI configuration
 * failure is projected onto the legacy `LLMProviderError`, because the legacy
 * contract reports a bad provider configuration as a provider failure.
 */
export function normalizeOpenAICompatibleOptions(
  options: OpenAICompatibleLLMProviderOptions,
): NormalizedOpenAICompatibleLLMProviderOptions {
  const parsedId = ProviderIdSchema.safeParse(options.id);
  if (!parsedId.success) {
    throw new LLMProviderError("Invalid OpenAI-compatible provider id.");
  }

  try {
    assertProviderEndpoint(options.baseURL, "OpenAI-compatible provider baseURL");
  } catch (error) {
    throw new LLMProviderError("Invalid OpenAI-compatible provider base URL.", { cause: error });
  }

  const capabilities = LLMCapabilitiesSchema.parse({
    ...defaultCapabilities,
    ...options.capabilities,
  });

  return {
    id: parsedId.data,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers === undefined ? undefined : { ...options.headers },
    queryParams: options.queryParams === undefined ? undefined : { ...options.queryParams },
    capabilities,
    allowedModels: options.allowedModels === undefined ? undefined : [...options.allowedModels],
    fetch: options.fetch,
  };
}
