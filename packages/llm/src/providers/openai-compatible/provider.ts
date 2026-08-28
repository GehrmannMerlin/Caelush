import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelRef } from "@caelush/protocol";
import type {
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  ProviderId,
} from "../../provider.js";
import type { LLMStreamEvent } from "../../events.js";
import { streamOpenAICompatible } from "./stream.js";
import {
  normalizeOpenAICompatibleOptions,
  type OpenAICompatibleLLMProviderOptions,
} from "./config.js";

export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly id: ProviderId;
  private readonly allowedModels: readonly string[] | undefined;
  private readonly capabilities: ReturnType<
    typeof normalizeOpenAICompatibleOptions
  >["capabilities"];
  private readonly upstreamProvider: ReturnType<
    typeof createOpenAICompatible<string, string, string, string>
  >;

  constructor(options: OpenAICompatibleLLMProviderOptions) {
    const normalized = normalizeOpenAICompatibleOptions(options);
    this.id = normalized.id;
    this.allowedModels = normalized.allowedModels;
    this.capabilities = normalized.capabilities;
    this.upstreamProvider = createOpenAICompatible<string, string, string, string>({
      name: normalized.id,
      baseURL: normalized.baseURL,
      includeUsage: true,
      ...(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }),
      ...(normalized.headers === undefined ? {} : { headers: normalized.headers }),
      ...(normalized.queryParams === undefined ? {} : { queryParams: normalized.queryParams }),
      ...(normalized.fetch === undefined ? {} : { fetch: normalized.fetch }),
    });
  }

  supportsModel(model: ModelRef): boolean {
    return (
      model.provider === this.id &&
      (this.allowedModels === undefined || this.allowedModels.includes(model.model))
    );
  }

  getCapabilities(model: ModelRef) {
    void model;
    return this.capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    return streamOpenAICompatible(this.upstreamProvider, request, context);
  }
}

export function createOpenAICompatibleLLMProvider(
  options: OpenAICompatibleLLMProviderOptions,
): LLMProvider {
  return new OpenAICompatibleLLMProvider(options);
}
