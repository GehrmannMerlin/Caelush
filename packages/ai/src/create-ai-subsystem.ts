import { createAIGateway } from "./gateway/ai-gateway.js";
import { createAIErrorSanitizer } from "./errors/error-sanitizer.js";
import { createApiAdapterRegistryBuilder } from "./adapters/api-adapter-registry-builder.js";
import { createCacheResolver } from "./cache/cache-resolver.js";
import { createLLMCallId } from "./ids/llm-call-id.js";
import { createModelCatalogBuilder } from "./models/model-catalog-builder.js";
import { createProviderRegistryBuilder } from "./providers/provider-registry-builder.js";
import { createReasoningResolver } from "./reasoning/reasoning-resolver.js";
import { describeValue } from "./internal/assertions.js";
import type { AIErrorSanitizer } from "./errors/error-sanitizer.js";
import type { AIGateway } from "./gateway/ai-gateway.js";
import type { AIProviderBinding } from "./providers/provider-binding.js";
import type { ApiAdapter } from "./adapters/api-adapter.js";
import type { ApiAdapterRegistry } from "./adapters/api-adapter-registry.js";
import type { LLMCallId } from "./ids/llm-call-id.js";
import type { ModelCatalog } from "./models/model-catalog.js";
import type { ModelDescriptorSourcePort } from "./models/model-descriptor-source-port.js";
import type { ProviderRegistry } from "./providers/provider-registry.js";
import type { ReasoningResolutionPolicy } from "./reasoning/reasoning-resolution.js";

/** Everything a host must supply to build an AI subsystem. */
export interface CreateAISubsystemOptions {
  readonly modelSources: readonly ModelDescriptorSourcePort[];
  readonly providers: readonly AIProviderBinding[];
  readonly adapters: readonly ApiAdapter[];
  readonly reasoningPolicy?: ReasoningResolutionPolicy;
  readonly defaultTimeoutMs?: number;
  readonly callIdFactory?: { create(): LLMCallId };
  readonly errorSanitizer?: AIErrorSanitizer;
}

/**
 * A fully composed, immutable AI core.
 *
 * Everything a caller needs is already wired: the gateway is ready to stream, and
 * the catalogs and registries are exposed read-only for inspection.
 */
export interface AISubsystem {
  readonly gateway: AIGateway;
  readonly models: ModelCatalog;
  readonly providers: ProviderRegistry;
  readonly adapters: ApiAdapterRegistry;
}

/**
 * Compose the AI core.
 *
 * Startup validates the whole wiring and fails fast, so a misconfigured subsystem
 * can never reach a model invocation:
 *
 * ```text
 * duplicate model source
 * duplicate provider
 * duplicate adapter
 * Provider.defaultApi exists
 * ModelDescriptor.api exists
 * ModelDescriptor provider exists
 * ```
 *
 * All of these are host configuration defects, so they are reported as
 * `TypeError`s rather than as `AIError`s. `AIError` is reserved for a model
 * invocation that failed; a subsystem that cannot be composed has no invocation to
 * report on.
 */
export function createAISubsystem(options: CreateAISubsystemOptions): AISubsystem {
  const { modelSources, providers, adapters } = options;

  // Duplicate ids are rejected by each builder, so the integrity checks below can
  // rely on a registry being a faithful, unique mapping.
  const catalogBuilder = createModelCatalogBuilder();
  for (const source of modelSources) catalogBuilder.registerSource(source);
  const models = catalogBuilder.build();

  const providerBuilder = createProviderRegistryBuilder();
  for (const binding of providers) providerBuilder.register(binding);
  const providersRegistry = providerBuilder.build();

  const adapterBuilder = createApiAdapterRegistryBuilder();
  for (const adapter of adapters) adapterBuilder.register(adapter);
  const adaptersRegistry = adapterBuilder.build();

  // Every provider's default dialect must be implemented, or the provider could
  // never serve a request.
  for (const descriptor of providersRegistry.list()) {
    if (!adaptersRegistry.has(descriptor.defaultApi)) {
      throw new TypeError(
        `AI provider "${descriptor.id}" declares defaultApi "${descriptor.defaultApi}", which no registered adapter implements.`,
      );
    }
  }

  // Every explicitly known model must name a registered dialect and a registered
  // provider. A catalog-only model with no provider is deliberately unsupported in
  // Phase 2A.
  for (const descriptor of models.list()) {
    if (!adaptersRegistry.has(descriptor.api)) {
      throw new TypeError(
        `AI model "${descriptor.ref.provider}/${descriptor.ref.model}" declares api "${descriptor.api}", which no registered adapter implements.`,
      );
    }
    if (!providersRegistry.has(descriptor.ref.provider)) {
      throw new TypeError(
        `AI model "${descriptor.ref.provider}/${descriptor.ref.model}" names provider "${descriptor.ref.provider}", which is not configured.`,
      );
    }
  }

  const reasoning = createReasoningResolver();
  const cache = createCacheResolver();
  const errors = options.errorSanitizer ?? createAIErrorSanitizer();
  const callIdFactory = options.callIdFactory ?? { create: createLLMCallId };

  if (
    options.defaultTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0)
  ) {
    throw new TypeError(
      `AI subsystem defaultTimeoutMs must be a positive safe integer, received ${describeValue(options.defaultTimeoutMs)}.`,
    );
  }
  if (typeof callIdFactory.create !== "function") {
    throw new TypeError("AI subsystem callIdFactory must implement create().");
  }
  if (typeof errors.sanitize !== "function") {
    throw new TypeError("AI subsystem errorSanitizer must implement sanitize().");
  }

  const gateway = createAIGateway(
    {
      models,
      providers: providersRegistry,
      adapters: adaptersRegistry,
      reasoning,
      cache,
      errors,
      callIdFactory,
    },
    {
      ...(options.reasoningPolicy === undefined
        ? {}
        : { reasoningPolicy: options.reasoningPolicy }),
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
    },
  );

  return Object.freeze({
    gateway,
    models,
    providers: providersRegistry,
    adapters: adaptersRegistry,
  });
}
