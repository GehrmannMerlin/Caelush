/**
 * `@caelush/ai` — the Architecture V2 AI Model Invocation core.
 *
 * Responsibility (Architecture V2, frozen):
 *   - Model, model limits, capabilities, reasoning and cache metadata
 *   - Provider connection and credential resolution
 *   - API dialect adapters
 *   - AI message, AI tool spec, unified stream, usage
 *   - AI error contracts and secret-safe sanitization
 *   - The gateway that owns call identity and the public stream envelope
 *
 * This package depends on **no** `@caelush/*` workspace package. In particular it
 * does not import `@caelush/protocol`; it owns its own `ModelRef`, `LLMCallId` and
 * `JsonObject` so the AI runtime stays an independent root. The projection between
 * the AI types and the Protocol wire types belongs to the consumer boundary.
 *
 * It knows nothing about Run, Session, Workspace, Runtime, Storage, Daemon,
 * Approval, Verification, Coding, Git, or the local filesystem. Those boundaries
 * are enforced by `pnpm check:architecture`.
 */
export { createAISubsystem } from "./create-ai-subsystem.js";
export type { AISubsystem, CreateAISubsystemOptions } from "./create-ai-subsystem.js";

/* Identifiers and AI-local JSON. */
export { API_ID_PATTERN, isValidApiId, RESERVED_API_IDS } from "./ids/api-id.js";
export type { ApiId, ReservedApiId } from "./ids/api-id.js";

export { isValidProviderId, PROVIDER_ID_PATTERN } from "./ids/provider-id.js";
export type { ProviderId } from "./ids/provider-id.js";

export {
  createLLMCallId,
  defaultLLMCallIdFactory,
  isLLMCallId,
  LLM_CALL_ID_PATTERN,
} from "./ids/llm-call-id.js";
export type { LLMCallId, LLMCallIdFactory } from "./ids/llm-call-id.js";

export { isJsonObject, isJsonValue } from "./json/json-value.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json/json-value.js";

/* Messages, tools and usage. */
export {
  assertAIAssistantContent,
  assertAIMessage,
  assertAIMessages,
  isAIAssistantContent,
} from "./messages/index.js";
export type {
  AIAssistantContent,
  AIAssistantMessage,
  AIAssistantTextContent,
  AIAssistantToolCallContent,
  AIMessage,
  AISystemMessage,
  AIToolResultMessage,
  AIUserMessage,
} from "./messages/index.js";

export {
  assertAIFinishReason,
  assertAIToolCall,
  AI_FINISH_REASONS,
  assertAIToolSpec,
  isAIFinishReason,
} from "./tools/index.js";
export type { AIFinishReason, AIToolCall, AIToolSpec } from "./tools/index.js";

export { assertModelUsage, normalizeModelUsage } from "./models/model-usage.js";
export type { ModelUsage } from "./models/model-usage.js";

/* Models. */
export { assertModelDescriptor, assertModelRef } from "./models/model-descriptor.js";
export type { ModelDescriptor } from "./models/model-descriptor.js";

export { assertModelLimits } from "./models/model-limits.js";
export type { ModelLimits } from "./models/model-limits.js";

export {
  assertModelCapabilities,
  CAPABILITY_SUPPORT_STATES,
  isAttemptable,
  isCapabilitySupport,
  isSupported,
  isUnsupported,
} from "./models/model-capabilities.js";
export type { CapabilitySupport, ModelCapabilities } from "./models/model-capabilities.js";

export { assertModelReasoningProfile } from "./models/model-reasoning-profile.js";
export type { ModelReasoningProfile } from "./models/model-reasoning-profile.js";

export { assertModelCacheProfile } from "./models/model-cache-profile.js";
export type { ModelCacheProfile } from "./models/model-cache-profile.js";

export {
  isFallbackDescriptorSource,
  isModelDescriptorSource,
  modelDescriptorSourceRank,
  MODEL_DESCRIPTOR_SOURCES,
} from "./models/model-descriptor-source.js";
export type { ModelDescriptorSource } from "./models/model-descriptor-source.js";

export { isEnumerableSource } from "./models/model-descriptor-source-port.js";
export type {
  EnumerableModelDescriptorSourcePort,
  ModelDescriptorSourcePort,
} from "./models/model-descriptor-source-port.js";

export { createModelCatalogBuilder } from "./models/model-catalog-builder.js";
export type { ModelCatalogBuilder } from "./models/model-catalog-builder.js";
export type { ModelCatalog } from "./models/model-catalog.js";

export { sameModelIdentity } from "./models/model-ref.js";
export type { ModelRef } from "./models/model-ref.js";

export type { AIModelTurnResult } from "./models/model-turn-result.js";

/* Request. */
export { assertAIToolChoice, AI_TOOL_CHOICE_TYPES } from "./request/tool-choice.js";
export type { AIToolChoice } from "./request/tool-choice.js";

export { assertAIModelSettings } from "./request/model-settings.js";
export type { AIModelSettings } from "./request/model-settings.js";

export type { AIModelRequest } from "./request/model-request.js";

export {
  validateAIModelRequest,
  validateAIModelRequestAgainstModel,
  validateAIModelRequestShape,
} from "./request/request-validator.js";

export type {
  AIInvocationResolution,
  ResolvedAIModelRequest,
} from "./request/resolved-model-request.js";

/* Reasoning and cache. */
export { REASONING_LEVELS, reasoningLevelIndex } from "./reasoning/reasoning-level.js";
export type { ReasoningLevel } from "./reasoning/reasoning-level.js";

export {
  DEFAULT_REASONING_RESOLUTION_POLICY,
  REASONING_RESOLUTION_MODES,
  REASONING_RESOLUTION_POLICIES,
} from "./reasoning/reasoning-resolution.js";
export type {
  AIReasoningRequest,
  ReasoningResolution,
  ReasoningResolutionPolicy,
} from "./reasoning/reasoning-resolution.js";

export { createReasoningResolver } from "./reasoning/reasoning-resolver.js";
export type { ReasoningResolver, ReasoningResolverInput } from "./reasoning/reasoning-resolver.js";

export {
  CACHE_RETENTIONS,
  cacheRetentionIndex,
  isCacheRetention,
} from "./cache/cache-retention.js";
export type { CacheRetention } from "./cache/cache-retention.js";

export { CACHE_RESOLUTION_MODES } from "./cache/cache-resolution.js";
export type { AICacheRequest, CacheResolution } from "./cache/cache-resolution.js";

export { createCacheResolver } from "./cache/cache-resolver.js";
export type { CacheResolver, CacheResolverInput } from "./cache/cache-resolver.js";

/* Providers. */
export type { ProviderCredentialResolver, ProviderCredentials } from "./providers/credentials.js";
export { assertAIProviderBinding, assertProviderEndpoint } from "./providers/provider-binding.js";
export type {
  AIProviderBinding,
  AIProviderTransportOverride,
} from "./providers/provider-binding.js";
export type { AIProviderDescriptor } from "./providers/provider-descriptor.js";
export { createProviderRegistryBuilder } from "./providers/provider-registry-builder.js";
export type { ProviderRegistryBuilder } from "./providers/provider-registry-builder.js";
export type { ProviderRegistry } from "./providers/provider-registry.js";
export type { ResolvedProviderConnection } from "./providers/resolved-provider-connection.js";

/* Adapters. */
export {
  AI_ADAPTER_EVENT_TYPES,
  GATEWAY_ENVELOPE_EVENT_TYPES,
} from "./adapters/api-adapter-event.js";
export type { AIAdapterEvent } from "./adapters/api-adapter-event.js";
export type { ApiAdapter, ApiAdapterStreamInput } from "./adapters/api-adapter.js";
export { createApiAdapterRegistryBuilder } from "./adapters/api-adapter-registry-builder.js";
export type { ApiAdapterRegistryBuilder } from "./adapters/api-adapter-registry-builder.js";
export type { ApiAdapterRegistry } from "./adapters/api-adapter-registry.js";

/* Errors. */
export {
  AI_ERROR_CODES,
  AI_ERROR_DEFAULT_MESSAGES,
  DEFAULT_AI_ERROR_RETRYABILITY,
} from "./errors/ai-error-code.js";
export type { AIErrorCode } from "./errors/ai-error-code.js";
export { AIError, createAIError, isAIError } from "./errors/ai-error.js";
export type { AIErrorContext } from "./errors/ai-error.js";
export { createAIErrorSanitizer, redactSecrets, REDACTED } from "./errors/error-sanitizer.js";
export type { AIErrorSanitizer, CreateAIErrorSanitizerOptions } from "./errors/error-sanitizer.js";
export type { AISerializableError } from "./errors/serializable-error.js";

/* Stream and gateway. */
export { AI_STREAM_EVENT_TYPES, isTerminalStreamEvent } from "./stream/events.js";
export type {
  AIReasoningSummaryDeltaEvent,
  AIStreamErrorEvent,
  AIStreamEvent,
  AIStreamFinishEvent,
  AIStreamStartEvent,
  AITextDeltaEvent,
  AIToolCallCompletedEvent,
  AIToolCallDeltaEvent,
  AIToolCallStartEvent,
  AIUsageEvent,
} from "./stream/events.js";

export type { AIStream, AIStreamOptions } from "./stream/stream.js";
export { createStreamValidator } from "./stream/stream-validator.js";
export type { AIStreamState, StreamValidator } from "./stream/stream-validator.js";
export { createAIModelTurnAssembler } from "./stream/turn-assembler.js";
export type { AIModelTurnAssembler } from "./stream/turn-assembler.js";
export { createAbortScope } from "./stream/abort-scope.js";
export type { AbortScope, AIAbortKind } from "./stream/abort-scope.js";

export { createAIGateway } from "./gateway/ai-gateway.js";
export type { AIGateway, AIGatewayDependencies, AIGatewayOptions } from "./gateway/ai-gateway.js";
export { createGatewayRequestResolver } from "./gateway/gateway-request-resolver.js";
export type {
  GatewayRequestResolver,
  GatewayRequestResolverDependencies,
  GatewayRequestResolverInput,
  GatewayRequestResolverOptions,
  ResolvedGatewayRequest,
} from "./gateway/gateway-request-resolver.js";
