export type {
  ContextEnginePort,
  ContextPrepareInput,
  ContextPrepareMode,
  ContextProvider,
  ContextProviderInput,
} from "./contracts/context-engine.js";

export {
  assertContextItem,
  createContextArtifactId,
  createContextItemId,
  createContextSourceId,
  createContextItem,
} from "./item/context-item.js";
export type {
  ContextArtifactId,
  ContextCacheStability,
  ContextFreshness,
  ContextItem,
  ContextItemId,
  ContextItemPayload,
  ContextPriorityClass,
  ContextRetention,
  ContextScope,
  ContextSensitivity,
  ContextSourceId,
  ContextItemSource,
  StructuredCheckpoint,
} from "./item/context-item.js";

export {
  assertContextFingerprint,
  createContextFingerprint,
} from "./contracts/context-fingerprint.js";
export type { ContextFingerprint } from "./contracts/context-fingerprint.js";
export type {
  ContextBuildReceipt,
  ContextDocument,
  PreparedAgentContext,
} from "./contracts/prepared-agent-context.js";

export { classifyContextPressure, createContextPolicy } from "./policy/context-policy.js";
export type {
  ContextBudgetSnapshot,
  ContextItemDecision,
  ContextItemDecisionReason,
  ContextItemDisposition,
  ContextPlan,
  ContextPolicy,
  ContextPolicyInput,
  ContextPolicyOptions,
  ContextPressureState,
} from "./policy/context-policy.js";

export {
  createContextRequestOverheadEstimator,
  assertContextRequestOverhead,
} from "./token/request-overhead-estimator.js";
export type {
  ContextRequestOverhead,
  ContextRequestOverheadEstimatorOptions,
  ContextRequestOverheadEstimatorPort,
} from "./token/request-overhead-estimator.js";
export {
  createUtf8HeuristicTokenEstimator,
  Utf8HeuristicTokenEstimator,
} from "./token/context-token-estimator.js";
export type { ContextTokenEstimatorPort } from "./token/context-token-estimator.js";

export { assertContextSourceResult } from "./source/context-source.js";
export type {
  ContextSourceCriticality,
  ContextSourceDiagnostic,
  ContextSourceInput,
  ContextSourceProvider,
  ContextSourceRegistration,
  ContextSourceRegistry,
  ContextSourceRegistryBuilder,
  ContextSourceResult,
  ContextSourceCollectionResult,
} from "./source/context-source.js";
export {
  collectContextSources,
  ContextSourceCollectionError,
  createContextSourceRegistryBuilder,
} from "./source/context-source-registry.js";
