import {
  createApiAdapterRegistryBuilder,
  createCacheResolver,
  createGatewayRequestResolver,
  createLLMCallId,
  createModelCatalogBuilder,
  createProviderRegistryBuilder,
  createReasoningResolver,
} from "@caelush/ai";
import {
  createOpenAICompatibleApiAdapter,
  OPENAI_COMPATIBLE_API_ID,
} from "@caelush/ai/adapters/openai-compatible";
import type {
  AIProviderBinding,
  ApiAdapterRegistry,
  GatewayRequestResolver,
  ModelCatalog,
  ModelDescriptorSourcePort,
  ProviderRegistry,
} from "@caelush/ai";
import type { ModelRef } from "@caelush/protocol";
import { normalizeOpenAICompatibleOptions } from "./config.js";
import type { OpenAICompatibleLLMProviderOptions } from "./config.js";
import { toCompatibilityDescriptor } from "../../compatibility/capability-projection.js";
import { toAIModelRef } from "../../compatibility/legacy-json.js";
import { toAIModelRequest } from "../../compatibility/request-projection.js";
import { toLegacyError } from "../../compatibility/error-projection.js";
import {
  toLegacyStreamEvents,
  toLegacyStreamStart,
} from "../../compatibility/stream-projection.js";
import type { LLMCapabilities } from "../../capabilities.js";
import type { LLMStreamEvent } from "../../events.js";
import type {
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  ProviderId,
} from "../../provider.js";

/**
 * The legacy `LLMProvider` implementation, now a compatibility facade.
 *
 * It owns **no** provider dialect work. Message translation, tool translation, the
 * OpenAI request body, stream parsing, usage normalisation, finish mapping and
 * provider error normalisation all live in
 * `@caelush/ai/adapters/openai-compatible`.
 *
 * What remains here is adaptation: a legacy request is projected onto the frozen AI
 * request contract, the AI preflight resolves the provider connection, the AI adapter
 * performs the single provider turn, and the AI events are projected back onto the
 * legacy stream contract.
 *
 * A legacy provider is no longer the canonical provider abstraction; the canonical
 * abstraction is `AIProviderBinding` plus `ApiAdapter`.
 */
export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly id: ProviderId;

  readonly #capabilities: LLMCapabilities;
  readonly #allowedModels: readonly string[] | undefined;
  readonly #models: ModelCatalog;
  readonly #resolver: GatewayRequestResolver;

  constructor(options: OpenAICompatibleLLMProviderOptions) {
    const normalized = normalizeOpenAICompatibleOptions(options);
    this.id = normalized.id;
    this.#capabilities = normalized.capabilities;
    this.#allowedModels = normalized.allowedModels;

    // The compatibility descriptor source answers for any model this provider is
    // asked about. It is intentionally not enumerable: a legacy provider describes
    // whatever model id it is handed, so it has no known set to list.
    const descriptorSource: ModelDescriptorSourcePort = {
      id: `${normalized.id}-compatibility`,
      priority: 0,
      resolve: (ref: ModelRef) =>
        ref.provider === normalized.id
          ? toCompatibilityDescriptor(ref, normalized.capabilities)
          : undefined,
    };
    const binding: AIProviderBinding = {
      id: normalized.id,
      endpoint: normalized.baseURL,
      defaultApi: OPENAI_COMPATIBLE_API_ID,
      ...(normalized.allowedModels === undefined
        ? {}
        : { allowedModels: normalized.allowedModels }),
      // The legacy contract supports any model id the provider was not explicitly
      // restricted from, so unknown models must be permitted here.
      allowUnknownModels: true,
      credentials: {
        resolve: () =>
          Promise.resolve(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }),
      },
      ...(normalized.headers === undefined ? {} : { headers: normalized.headers }),
      ...(normalized.queryParams === undefined ? {} : { queryParams: normalized.queryParams }),
      ...(normalized.fetch === undefined ? {} : { transport: { fetch: normalized.fetch } }),
    };

    const catalogBuilder = createModelCatalogBuilder();
    catalogBuilder.registerSource(descriptorSource);
    this.#models = catalogBuilder.build();

    const providerBuilder = createProviderRegistryBuilder();
    providerBuilder.register(binding);
    const providers: ProviderRegistry = providerBuilder.build();

    const adapterBuilder = createApiAdapterRegistryBuilder();
    adapterBuilder.register(createOpenAICompatibleApiAdapter());
    const adapters: ApiAdapterRegistry = adapterBuilder.build();

    this.#resolver = createGatewayRequestResolver(
      {
        models: this.#models,
        providers,
        adapters,
        // The legacy request has no reasoning or cache field, so the frozen resolvers
        // report "not requested" for every legacy call. Reusing them keeps exactly one
        // resolution implementation.
        reasoning: createReasoningResolver(),
        cache: createCacheResolver(),
        // The AI call id is not the legacy identity: the legacy gateway owns that and
        // the facade reports it in `stream.start`. Minting a well-formed AI identity
        // keeps the resolver contract honest without inventing a placeholder.
        callIdFactory: { create: createLLMCallId },
      },
      // No default timeout: the legacy `LLMGateway` stays the single timeout authority
      // for this path, and the adapter must not create a second one.
    );
  }

  supportsModel(model: ModelRef): boolean {
    return (
      model.provider === this.id &&
      (this.#allowedModels === undefined || this.#allowedModels.includes(model.model))
    );
  }

  getCapabilities(model: ModelRef): LLMCapabilities {
    void model;
    return this.#capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    return this.#stream(request, context);
  }

  async *#stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncGenerator<LLMStreamEvent> {
    const prepared = await this.#resolver.resolve({
      request: toAIModelRequest(request),
      // The legacy gateway owns cancellation and timeout. Forwarding its signal with
      // no timeout of our own keeps exactly one timeout authority.
      options: { signal: context.signal },
    });

    try {
      yield toLegacyStreamStart({
        callId: context.callId,
        providerId: this.id,
        // The legacy validator compares the announced model with the requested one,
        // including `baseUrl`, so the request ref is echoed verbatim.
        model: request.model,
      });

      const events = prepared.adapter.stream({
        model: prepared.descriptor,
        provider: prepared.connection,
        request: prepared.request,
        signal: prepared.scope.signal,
      });

      for await (const event of events) {
        yield* toLegacyStreamEvents(event);
      }
    } catch (error) {
      throw toLegacyError(error, { providerId: this.id, model: toAIModelRef(request.model) });
    } finally {
      prepared.scope.cleanup();
    }
  }
}

export function createOpenAICompatibleLLMProvider(
  options: OpenAICompatibleLLMProviderOptions,
): LLMProvider {
  return new OpenAICompatibleLLMProvider(options);
}
