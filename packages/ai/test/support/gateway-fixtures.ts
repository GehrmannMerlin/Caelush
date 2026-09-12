import { createAIErrorSanitizer } from "../../src/errors/error-sanitizer.js";
import { createApiAdapterRegistryBuilder } from "../../src/adapters/api-adapter-registry-builder.js";
import { createCacheResolver } from "../../src/cache/cache-resolver.js";
import { createLLMCallId } from "../../src/ids/llm-call-id.js";
import { createModelCatalogBuilder } from "../../src/models/model-catalog-builder.js";
import { createProviderRegistryBuilder } from "../../src/providers/provider-registry-builder.js";
import { createReasoningResolver } from "../../src/reasoning/reasoning-resolver.js";
import type { AIProviderBinding } from "../../src/providers/provider-binding.js";
import type { AIGatewayDependencies } from "../../src/gateway/ai-gateway.js";
import type { ApiAdapter } from "../../src/adapters/api-adapter.js";
import type { ModelDescriptor } from "../../src/models/model-descriptor.js";
import type {
  EnumerableModelDescriptorSourcePort,
  ModelDescriptorSourcePort,
} from "../../src/models/model-descriptor-source-port.js";
import type { ModelRef } from "../../src/models/model-ref.js";
import type { ProviderCredentialResolver } from "../../src/providers/credentials.js";

/** A credential resolver that resolves asynchronously, like a real secret lookup. */
export function fakeCredentialResolver(
  resolve: ProviderCredentialResolver["resolve"] = () =>
    Promise.resolve({ apiKey: "test-api-key" }),
): ProviderCredentialResolver {
  return { resolve };
}

/** A credential resolver that waits before answering, for async-preflight tests. */
export function delayedCredentialResolver(delayMs: number): {
  resolver: ProviderCredentialResolver;
  resolved(): boolean;
} {
  let done = false;
  return {
    resolved: () => done,
    resolver: {
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        done = true;
        return { apiKey: "test-api-key" };
      },
    },
  };
}

/**
 * A model source that describes exactly the given descriptors.
 *
 * A fixed set is by definition enumerable, so it also implements `list()`. This is
 * what lets the catalog and the subsystem startup integrity checks see the models.
 */
export function fixedModelSource(
  descriptors: readonly ModelDescriptor[],
  id = "fixed",
  priority = 0,
): EnumerableModelDescriptorSourcePort {
  return {
    id,
    priority,
    resolve: (ref: ModelRef) =>
      descriptors.find(
        (descriptor) =>
          descriptor.ref.provider === ref.provider && descriptor.ref.model === ref.model,
      ),
    list: () => [...descriptors],
  };
}

/**
 * An enumerable model source describing exactly one model.
 *
 * `createAISubsystem` validates the known model set at startup, and a source must be
 * enumerable to contribute to it.
 */
export function singleModelSource(
  descriptor: ModelDescriptor,
  id = "single",
): EnumerableModelDescriptorSourcePort {
  return {
    id,
    priority: 0,
    resolve: (ref: ModelRef) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };
}

/** A provider binding with a working fake credential resolver. */
export function testProviderBinding(overrides: Partial<AIProviderBinding> = {}): AIProviderBinding {
  return {
    id: "test",
    endpoint: "https://api.test.example/v1",
    defaultApi: "test-api",
    allowUnknownModels: false,
    credentials: fakeCredentialResolver(),
    ...overrides,
  };
}

export interface TestGatewayDependenciesOptions {
  readonly descriptors?: readonly ModelDescriptor[];
  readonly modelSources?: readonly ModelDescriptorSourcePort[];
  readonly providers?: readonly AIProviderBinding[];
  readonly adapters: readonly ApiAdapter[];
}

/** Build gateway dependencies from plain test data. */
export function testGatewayDependencies(
  options: TestGatewayDependenciesOptions,
): AIGatewayDependencies {
  const catalogBuilder = createModelCatalogBuilder();
  for (const source of options.modelSources ?? []) catalogBuilder.registerSource(source);
  if (options.descriptors !== undefined) {
    catalogBuilder.registerSource(fixedModelSource(options.descriptors));
  }

  const providerBuilder = createProviderRegistryBuilder();
  for (const binding of options.providers ?? [testProviderBinding()]) {
    providerBuilder.register(binding);
  }

  const adapterBuilder = createApiAdapterRegistryBuilder();
  for (const adapter of options.adapters) adapterBuilder.register(adapter);

  return {
    models: catalogBuilder.build(),
    providers: providerBuilder.build(),
    adapters: adapterBuilder.build(),
    reasoning: createReasoningResolver(),
    cache: createCacheResolver(),
    errors: createAIErrorSanitizer(),
    callIdFactory: { create: createLLMCallId },
  };
}
