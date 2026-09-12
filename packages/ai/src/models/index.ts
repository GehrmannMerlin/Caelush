export { assertModelCacheProfile } from "./model-cache-profile.js";
export type { ModelCacheProfile } from "./model-cache-profile.js";

export {
  assertModelCapabilities,
  CAPABILITY_SUPPORT_STATES,
  isAttemptable,
  isCapabilitySupport,
  isSupported,
  isUnsupported,
  MODEL_CAPABILITY_FIELDS,
} from "./model-capabilities.js";
export type { CapabilitySupport, ModelCapabilities } from "./model-capabilities.js";

export { createModelCatalogBuilder } from "./model-catalog-builder.js";
export type { ModelCatalogBuilder } from "./model-catalog-builder.js";

export {
  collectCatalogDescriptors,
  describesSameModel,
  ImmutableModelCatalog,
} from "./model-catalog.js";
export type { ModelCatalog } from "./model-catalog.js";

export { assertModelDescriptor, assertModelRef } from "./model-descriptor.js";
export type { ModelDescriptor } from "./model-descriptor.js";

export { snapshotDescriptor, resolveSourceDescriptor } from "./model-descriptor-snapshot.js";

export { isEnumerableSource } from "./model-descriptor-source-port.js";
export type {
  EnumerableModelDescriptorSourcePort,
  ModelDescriptorSourcePort,
} from "./model-descriptor-source-port.js";

export {
  isFallbackDescriptorSource,
  isModelDescriptorSource,
  modelDescriptorSourceRank,
  MODEL_DESCRIPTOR_SOURCES,
} from "./model-descriptor-source.js";
export type { ModelDescriptorSource } from "./model-descriptor-source.js";

export { assertModelLimits } from "./model-limits.js";
export type { ModelLimits } from "./model-limits.js";

export { assertModelReasoningProfile } from "./model-reasoning-profile.js";
export type { ModelReasoningProfile } from "./model-reasoning-profile.js";

export { sameModelIdentity } from "./model-ref.js";
export type { ModelRef } from "./model-ref.js";

export { assertModelUsage, MODEL_USAGE_FIELDS, normalizeModelUsage } from "./model-usage.js";
export type { ModelUsage } from "./model-usage.js";

export type { AIModelTurnResult } from "./model-turn-result.js";
