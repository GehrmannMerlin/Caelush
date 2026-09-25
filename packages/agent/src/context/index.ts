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
  PreparedAgentContext,
} from "./contracts/prepared-agent-context.js";
export type { RehydratedContextState } from "./contracts/rehydrated-context-state.js";

export {
  ContextDocumentConstructionError,
  createContextDocumentBuilder,
} from "./document/context-document.js";
export type {
  ContextDocument,
  ContextDocumentBuilder,
  ContextDocumentSection,
  ContextSectionAuthority,
} from "./document/context-document.js";

export { createContextHistoryIndexer } from "./history/semantic-history-unit.js";
export type {
  ContextHistoryIndex,
  ContextHistoryIndexer,
  ContextHistoryUnit,
  ContextHistoryUnitKind,
  ContextHistoryUnitStatus,
  ContextMessageRef,
  ToolProtocolUnit,
} from "./history/semantic-history-unit.js";

export {
  ContextCurrentTurnTooLargeError,
  ContextMandatoryInputTooLargeError,
  ContextPlanningError,
} from "./planner/context-planning-errors.js";
export type { ContextPlanningErrorCode } from "./planner/context-planning-errors.js";
export { assertContextPlan, createContextPlanner, planContext } from "./planner/context-planner.js";
export type { ContextPlanner, ContextPlannerInput } from "./planner/context-planner.js";

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
export {
  createContextSourceItem,
  freezeContextSourceResult,
} from "./source/context-source-item.js";
export { AGENT_CONTEXT_SOURCE_IDS } from "./source/source-ids.js";
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
