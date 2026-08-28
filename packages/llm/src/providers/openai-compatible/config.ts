import type { LLMCapabilities } from "../../capabilities.js";
import { LLMCapabilitiesSchema } from "../../capabilities.js";
import { LLMProviderError } from "../../errors.js";
import { ProviderIdSchema } from "../../provider.js";
import type { ProviderId } from "../../provider.js";

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

export function normalizeOpenAICompatibleOptions(
  options: OpenAICompatibleLLMProviderOptions,
): NormalizedOpenAICompatibleLLMProviderOptions {
  const parsedId = ProviderIdSchema.safeParse(options.id);
  if (!parsedId.success) {
    throw new LLMProviderError("Invalid OpenAI-compatible provider id.");
  }

  let baseURL: URL;
  try {
    baseURL = new URL(options.baseURL);
  } catch (error) {
    throw new LLMProviderError("Invalid OpenAI-compatible provider base URL.", { cause: error });
  }
  if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
    throw new LLMProviderError("OpenAI-compatible provider base URL must use HTTP or HTTPS.");
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
