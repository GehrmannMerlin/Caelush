import { createAbortScope } from "../stream/abort-scope.js";
import { AIError, createAIError } from "../errors/ai-error.js";
import { describeValue } from "../internal/assertions.js";
import { isFallbackDescriptorSource } from "../models/model-descriptor-source.js";
import {
  validateAIModelRequestAgainstModel,
  validateAIModelRequestShape,
} from "../request/request-validator.js";
import type { AbortScope } from "../stream/abort-scope.js";
import type { AIErrorContext } from "../errors/index.js";
import type {
  AIInvocationResolution,
  ResolvedAIModelRequest,
} from "../request/resolved-model-request.js";
import type { AIModelRequest } from "../request/model-request.js";
import type { AIProviderBinding } from "../providers/provider-binding.js";
import type { AIStreamOptions } from "../stream/index.js";
import type { ApiAdapter } from "../adapters/api-adapter.js";
import type { ApiAdapterRegistry } from "../adapters/api-adapter-registry.js";
import type { CacheResolver } from "../cache/cache-resolver.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelCatalog } from "../models/model-catalog.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ProviderCredentials } from "../providers/credentials.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { ReasoningResolutionPolicy } from "../reasoning/reasoning-resolution.js";
import type { ReasoningResolver } from "../reasoning/reasoning-resolver.js";
import type { ResolvedProviderConnection } from "../providers/resolved-provider-connection.js";

/**
 * The collaborators the resolver needs.
 *
 * This is the same dependency set the gateway uses; it is named separately so the
 * resolver can be exercised on its own.
 */
export interface GatewayRequestResolverDependencies {
  readonly models: ModelCatalog;
  readonly providers: ProviderRegistry;
  readonly adapters: ApiAdapterRegistry;
  readonly reasoning: ReasoningResolver;
  readonly cache: CacheResolver;
  readonly callIdFactory: { create(): LLMCallId };
}

/** Resolver policy that is not per-request. */
export interface GatewayRequestResolverOptions {
  readonly reasoningPolicy?: ReasoningResolutionPolicy;
  readonly defaultTimeoutMs?: number;
}

/** One request plus its per-call options. */
export interface GatewayRequestResolverInput {
  readonly request: AIModelRequest;
  readonly options?: AIStreamOptions;
}

/**
 * Everything preflight produced, ready for the runtime half.
 *
 * `connection` carries credentials and never leaves the adapter boundary.
 * `scope` owns the transport signal and must be cleaned up by whoever consumes
 * this resolution.
 */
export interface ResolvedGatewayRequest {
  readonly callId: LLMCallId;
  readonly descriptor: ModelDescriptor;
  readonly model: ModelRef;
  readonly providerId: string;
  readonly adapter: ApiAdapter;
  readonly request: ResolvedAIModelRequest;
  readonly resolution: AIInvocationResolution;
  readonly connection: ResolvedProviderConnection;
  readonly scope: AbortScope;
}

/**
 * Runs the frozen preflight sequence and produces an adapter-ready invocation.
 *
 * This is steps 1-16 of the frozen order, in that exact order:
 *
 * ```text
 *  1 validate request          9 reasoning resolver
 *  2 normalise identity       10 cache resolver
 *  3 catalog resolve          11 max output tokens
 *  4 provider get             12 timeout validation
 *  5 allowedModels policy     13 resolve credentials
 *  6 adapter get              14 merge connection
 *  7 tool semantics           15 create call id
 *  8 capability validation    16 build resolved request
 * ```
 *
 * Every failure here is a preflight failure and is thrown. Nothing in this method
 * touches the network, so "throw before provider I/O" is guaranteed by
 * construction: credentials are the only thing that can await, and they are
 * resolved before any adapter is invoked.
 */
export interface GatewayRequestResolver {
  resolve(input: GatewayRequestResolverInput): Promise<ResolvedGatewayRequest>;
}

/** Create the frozen preflight resolver. */
export function createGatewayRequestResolver(
  dependencies: GatewayRequestResolverDependencies,
  options: GatewayRequestResolverOptions = {},
): GatewayRequestResolver {
  const reasoningPolicy = options.reasoningPolicy ?? "PREFER_BUDGET";

  return {
    async resolve(input: GatewayRequestResolverInput): Promise<ResolvedGatewayRequest> {
      const { request, options: streamOptions } = input;

      // Step 1 — validate the request before anything is looked up.
      validateAIModelRequestShape(request);

      // Step 2 — normalise model identity. `baseUrl` is legacy compatibility only
      // and must not participate in identity, routing or endpoint authority, so
      // the canonical identity is `provider + model` and nothing else.
      const model: ModelRef = { provider: request.model.provider, model: request.model.model };

      // Step 3 — resolve the model descriptor, or fail as incomplete metadata.
      const descriptor = dependencies.models.resolve(model);

      // Step 4 — resolve the provider connection.
      const provider = dependencies.providers.get(model.provider);

      // Step 5 — provider model policy. `allowedModels` is authoritative when
      // present; otherwise a guess from safe defaults needs `allowUnknownModels`.
      validateProviderModelPolicy(provider, descriptor, model);

      // Step 6 — resolve the API dialect adapter.
      const adapter = dependencies.adapters.get(descriptor.api);

      // Steps 7, 8 and 11 — tool semantics, capability rejection and the model's
      // output ceiling.
      validateAIModelRequestAgainstModel(request, descriptor);

      // Step 9 — settle reasoning.
      const reasoning = dependencies.reasoning.resolve({
        model: descriptor,
        policy: reasoningPolicy,
        ...(request.settings?.reasoning === undefined
          ? {}
          : { request: request.settings.reasoning }),
      });

      // Step 10 — settle caching. Never a failure: only a downgrade.
      const cache = dependencies.cache.resolve({
        model: descriptor,
        ...(request.settings?.cache === undefined ? {} : { request: request.settings.cache }),
      });

      // Step 11 — the effective output ceiling. The model limit is the ceiling
      // when the caller names none, so an adapter never has to know the limit.
      const maxOutputTokens =
        request.settings?.maxOutputTokens ?? descriptor.limits.maxOutputTokens;

      // Step 12 — validate the timeout before creating any scope.
      const timeoutMs = validateTimeout(
        streamOptions?.timeoutMs ?? options.defaultTimeoutMs,
        provider.id,
        model,
      );

      const resolution: AIInvocationResolution = {
        api: descriptor.api,
        reasoning,
        cache,
        maxOutputTokens,
      };

      // The abort scope covers credential resolution as well as the provider turn:
      // the invocation timeout is a property of the whole invocation.
      const scope = createAbortScope(streamOptions?.signal, timeoutMs);

      let credentials;
      try {
        // Step 13 — resolve credentials. A failure here happens before any
        // provider I/O, so it is a preflight failure, not a stream error.
        credentials = await resolveCredentials(provider, scope, model);
      } catch (error) {
        scope.cleanup();
        throw error;
      }

      // Step 14 — merge the resolved connection. Credentials win over the binding
      // for a colliding header or query parameter, because they are the more
      // specific, per-invocation value.
      const connection: ResolvedProviderConnection = {
        providerId: provider.id,
        endpoint: provider.endpoint,
        credentials,
        headers: Object.freeze({ ...provider.headers, ...credentials.headers }),
        queryParams: Object.freeze({ ...provider.queryParams, ...credentials.queryParams }),
        ...(provider.compatibility === undefined ? {} : { compatibility: provider.compatibility }),
        ...(provider.transport === undefined ? {} : { transport: provider.transport }),
      };

      // Step 15 — mint the gateway-owned call id.
      const callId = dependencies.callIdFactory.create();

      // Step 16 — construct the resolved request.
      const resolvedRequest = freezeResolvedRequest(
        descriptor,
        request,
        reasoning,
        cache,
        maxOutputTokens,
      );

      return {
        callId,
        descriptor,
        model,
        providerId: provider.id,
        adapter,
        request: resolvedRequest,
        resolution,
        connection,
        scope,
      };
    },
  };
}

/** Step 5: the provider's model allowlist and unknown-model gate. */
function validateProviderModelPolicy(
  provider: AIProviderBinding,
  descriptor: ModelDescriptor,
  model: ModelRef,
): void {
  if (provider.allowedModels !== undefined) {
    if (!provider.allowedModels.includes(model.model)) {
      throw createAIError(
        "AI_MODEL_UNSUPPORTED",
        `AI provider "${provider.id}" does not allow the model "${model.model}".`,
        { providerId: provider.id, model },
      );
    }
    return;
  }

  // An unknown model may only be described by safe defaults when the provider
  // explicitly allows unknown models. Without that consent the model has no
  // trustworthy metadata, which is a different failure from "not allowed".
  if (isFallbackDescriptorSource(descriptor.source) && !provider.allowUnknownModels) {
    throw createAIError(
      "AI_MODEL_METADATA_INCOMPLETE",
      `AI provider "${provider.id}" does not allow unknown models, so model "${model.model}" has no trustworthy metadata.`,
      { providerId: provider.id, model },
    );
  }
}

/** Step 12: the invocation timeout must be a positive safe integer. */
function validateTimeout(
  timeoutMs: number | undefined,
  providerId: string,
  model: ModelRef,
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw createAIError(
      "AI_INVALID_REQUEST",
      `AI invocation timeout must be a positive safe integer, received ${describeValue(timeoutMs)}.`,
      { providerId, model },
    );
  }
  return timeoutMs;
}

/** Step 13: resolve credentials, mapping a failure onto the preflight error set. */
async function resolveCredentials(
  provider: AIProviderBinding,
  scope: AbortScope,
  model: ModelRef,
): Promise<ProviderCredentials> {
  let credentials: unknown;
  try {
    credentials = await provider.credentials.resolve(scope.signal);
  } catch (error) {
    throw credentialFailure(error, scope, provider, model);
  }

  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw credentialFailure(undefined, scope, provider, model);
  }
  return credentials as ProviderCredentials;
}

/**
 * Map a credential failure onto a preflight error.
 *
 * An abort during credential resolution is reported as the abort it was, not as an
 * authentication problem.
 */
function credentialFailure(
  cause: unknown,
  scope: AbortScope,
  provider: AIProviderBinding,
  model: ModelRef,
): AIError {
  const context: AIErrorContext = {
    providerId: provider.id,
    model,
    ...(cause === undefined ? {} : { cause }),
  };
  const kind = scope.kind();

  if (kind === "timeout") return createAIError("AI_TIMEOUT", undefined, context);
  if (kind !== undefined) return createAIError("AI_ABORTED", undefined, context);
  if (cause instanceof AIError) return cause;

  return createAIError(
    "AI_AUTHENTICATION",
    `AI provider "${provider.id}" credentials could not be resolved.`,
    context,
  );
}

function freezeResolvedRequest(
  descriptor: ModelDescriptor,
  request: AIModelRequest,
  reasoning: AIInvocationResolution["reasoning"],
  cache: AIInvocationResolution["cache"],
  maxOutputTokens: number,
): ResolvedAIModelRequest {
  return Object.freeze({
    model: descriptor,
    messages: Object.freeze([...request.messages]),
    ...(request.tools === undefined ? {} : { tools: Object.freeze([...request.tools]) }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    settings: Object.freeze({
      maxOutputTokens,
      ...(request.settings?.temperature === undefined
        ? {}
        : { temperature: request.settings.temperature }),
      reasoning,
      cache,
    }),
  });
}
