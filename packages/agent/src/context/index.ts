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
} from "./item/context-item.js";
export {
  assertStructuredCheckpoint,
  createStructuredCheckpoint,
} from "./checkpoint/structured-checkpoint.js";
export type {
  CheckpointSourceRange,
  StructuredCheckpoint,
} from "./checkpoint/structured-checkpoint.js";

export {
  CONTEXT_COMPACTION_REASONS,
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
} from "./compaction/context-compaction-contracts.js";
export type {
  ContextCheckpointCreateInputV2,
  ContextCheckpointId,
  ContextCheckpointRecordV2,
  ContextCheckpointRef,
  ContextCheckpointRepositoryPort,
  ContextCompactionPlan,
  ContextCompactionPlanner,
  ContextCompactionReason,
  ContextMessageRange,
  ContextSummarizationInput,
  ContextSummarizationResult,
  ContextSummarizerPort,
  ContextSummaryPromptVersion,
  LegacyContextCheckpointRecordV1,
} from "./compaction/context-compaction-contracts.js";
export type {
  ContextAuthorityProviderPort,
  ContextAuthoritySnapshot,
  ContextRehydratorPort,
  RehydratedContextState,
} from "./rehydration/context-authority-contracts.js";

export {
  assertContextFingerprint,
  createContextFingerprint,
} from "./contracts/context-fingerprint.js";
export type { ContextFingerprint } from "./contracts/context-fingerprint.js";
export type {
  ContextBuildReceipt,
  PreparedAgentContext,
} from "./contracts/prepared-agent-context.js";
export type { RehydratedContextState as LegacyRehydratedContextState } from "./contracts/rehydrated-context-state.js";

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
export { createConversationContextSourceProvider } from "./source/conversation-provider.js";
export { createCheckpointContextSourceProvider } from "./source/checkpoint-provider.js";
export type {
  CheckpointContextSourceProviderOptions,
  ContextCheckpointLoader,
  ContextCheckpointProjection,
} from "./source/checkpoint-provider.js";
export { createMemoryContextSourceProvider } from "./source/memory-provider.js";
export type {
  ContextMemoryLoader,
  ContextMemoryProjection,
  MemoryContextSourceProviderOptions,
} from "./source/memory-provider.js";
export { createExtensionContributionContextSourceProvider } from "./source/extension-contribution-provider.js";
export type {
  ContextContributionLoader,
  ExtensionContributionContextSourceProviderOptions,
} from "./source/extension-contribution-provider.js";
export { createBranchContextSourceProvider } from "./source/branch-context-provider.js";
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
