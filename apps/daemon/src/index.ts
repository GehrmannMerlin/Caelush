export { buildDaemonApp } from "./app.js";
export type { DaemonDependencies } from "./app.js";
export {
  EventCursorAheadError,
  RunEventHub,
  RunEventHubDisposedError,
  RunEventReplayError,
  DEFAULT_SUBSCRIBER_QUEUE_POLICY,
} from "./events/index.js";
export type {
  ObserverErrorSink,
  RunEventDeliveryContext,
  RunEventHubOptions,
  RunEventObserver,
  RunEventStream,
  RunEventSubscription,
  RunEventSubscriptionCloseReason,
  RunEventSubscriptionFilter,
  RunEventWatchOptions,
  SubscriberQueuePolicy,
} from "./events/index.js";
export {
  DEFAULT_DAEMON_CONFIG,
  assertLoopbackDaemonHost,
  createDaemonConfig,
  readProviderConfiguration,
} from "./config.js";
export type { DaemonConfig, DaemonProviderStartupConfiguration } from "./config.js";
export { startDaemon } from "./daemon.js";
export type { DaemonHandle, DaemonOptions } from "./daemon.js";
export { daemonEntryPath } from "./entry.js";
export { resolveProductPaths } from "./product-paths.js";
export type { ProductPathEnvironment, ProductPathOptions, ProductPaths } from "./product-paths.js";
export { DAEMON_VERSION } from "./version.js";
export { WorkspacePathError, WorkspaceService } from "./workspaces/workspace-service.js";
export {
  createNativeWorkspaceDirectoryPicker,
  createWindowsWorkspaceDirectoryPicker,
} from "./workspaces/workspace-picker.js";
export type {
  WorkspaceDirectoryPicker,
  WorkspacePickerProcess,
  WorkspacePickerProcessOptions,
} from "./workspaces/workspace-picker.js";
export { ActiveRunConflictError, WorkspaceOwnershipError } from "./workspaces/workspace-errors.js";
export type {
  WorkspaceRegistration,
  WorkspaceServiceOptions,
} from "./workspaces/workspace-service.js";
export { backfillSessionWorkspaceOwnership } from "./workspaces/workspace-backfill.js";
export type {
  WorkspaceBackfillOptions,
  WorkspaceBackfillSummary,
} from "./workspaces/workspace-backfill.js";
export { registerWebStaticHost } from "./web/static-host.js";
export type { WebStaticHostOptions } from "./web/static-host.js";
export {
  createStableWorkspaceId,
  createWorkspaceRef,
  normalizeWorkspaceIdentityPath,
} from "./web/workspace-launch-context.js";
export { checkNodePtyLoadability, inspectMigrationAssets } from "./diagnostics.js";
export type { MigrationAssetInspection, NodePtyLoadability } from "./diagnostics.js";
export { composeDaemon } from "./daemon-composition.js";
export { MemoryExtractionWorker } from "./memory/memory-extraction-worker.js";
export type { MemoryExtractionWorkerOptions } from "./memory/memory-extraction-worker.js";
export type {
  DaemonClock,
  DaemonComposition,
  DaemonCompositionOptions,
} from "./daemon-composition.js";
export {
  EnvironmentCredentialReadOnlyError,
  createRuntimeProviderCredentialAuthority,
  createRuntimeProviderCredentialResolver,
} from "./providers/credential-authority.js";
export type {
  RuntimeProviderCredentialAuthority,
  RuntimeProviderCredentialAuthorityOptions,
  RuntimeProviderCredentialStatus,
} from "./providers/credential-authority.js";
export {
  ProviderPresetRegistry,
  createProviderPresetRegistry,
  listBuiltinProviderPresets,
  toProviderPresetBinding,
} from "./providers/provider-presets.js";
export type {
  ProviderCredentialTransport,
  ProviderDiscoveryDialect,
  ProviderPreset,
} from "./providers/provider-presets.js";
export {
  ModelDiscoveryError,
  ModelSelectionError,
  RuntimeModelDirectoryService,
} from "./providers/model-directory.js";
export type { RuntimeModelDirectoryServiceOptions } from "./providers/model-directory.js";
export { AIConfigurationService } from "./services/ai-configuration-service.js";
export type { AIConfigurationServiceOptions } from "./services/ai-configuration-service.js";
export {
  SecurityCapabilityService,
  type RunSecurityRuntimeFacts,
  type SecurityCapabilityServiceOptions,
  type WorkspacePreparationPort,
} from "./services/security-capability-service.js";
export {
  inspectSecurityFeatureGates,
  resolveSecurityFeatureGates,
  SECURITY_FEATURE_GATE_ENVIRONMENT_KEYS,
} from "./services/security-feature-gates.js";
export type {
  SecurityFeatureGateInspection,
  SecurityFeatureGates,
} from "./services/security-feature-gates.js";
export {
  RunSecurityPromptProjector,
  type SystemContextBlock,
} from "./services/run-security-prompt-projector.js";
export {
  CatalogModelCanonicalizer,
  DaemonModelConfigurationError,
  toClientModelSelection,
} from "./providers/model-canonicalizer.js";
export type {
  DaemonModelCanonicalizer,
  DaemonModelProviderConfig,
} from "./providers/model-canonicalizer.js";
export {
  RunExecutionSupervisor,
  RunExecutionSupervisorBusyError,
  RunExecutionSupervisorConflictError,
  RunExecutionSupervisorInfrastructureError,
} from "./execution/run-execution-supervisor.js";
export type {
  RunExecutionController,
  RunExecutionSupervisorDisposition,
  RunExecutionSupervisorLogger,
  RunExecutionSupervisorOptions,
  RunExecutionSupervisorResult,
} from "./execution/run-execution-supervisor.js";
export {
  createRunBoundVerificationExecution,
  createRuntimeGitVerificationPort,
  createRuntimeWorkspaceVerificationPort,
} from "./verification-runtime-adapters.js";
export {
  MAX_SESSION_HISTORY_RUNS,
  SessionConversationContextProvider,
} from "./services/session-conversation-context.js";
export type { SessionConversationContextProviderOptions } from "./services/session-conversation-context.js";
